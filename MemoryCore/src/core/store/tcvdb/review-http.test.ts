import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TcvdbMemoryStore } from "./memory-store.js";
import type { TcvdbClient } from "./client.js";
import { __setMemoryReviewEnabledForTests } from "../visibility.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { IMemoryStore, MemoryEvent } from "../types.js";
import { newMemoryEventId } from "../memory-event-id.js";
import { ReviewCapabilityError, reviewEventId } from "../review.js";

function matches(doc: Record<string, unknown>, expression?: string): boolean {
  if (!expression) return true;
  const tokens = expression.match(/"(?:\\.|[^"\\])*"|[a-zA-Z_][a-zA-Z_0-9]*|\d+|>=|<=|!=|[=<>(),]/g) ?? [];
  let position = 0;
  const take = () => tokens[position++]!;
  const expectToken = (s: string) => { if (take() !== s) throw new Error("Invalid fixture filter"); };
  const value = () => { const t = take(); return t.startsWith('"') ? JSON.parse(t) as unknown : Number(t); };
  const atom = (): boolean => {
    if (tokens[position] === "(") { take(); const result = or(); expectToken(")"); return result; }
    const field = take();
    const operator = take();
    if (operator === "in") {
      expectToken("("); const values: unknown[] = [value()];
      while (tokens[position] === ",") { take(); values.push(value()); }
      expectToken(")"); return values.includes(doc[field]);
    }
    const right = value();
    if (operator === "=") return doc[field] === right;
    if (operator === "!=") return doc[field] !== right;
    if (operator === ">") return Number(doc[field]) > Number(right);
    if (operator === "<") return Number(doc[field]) < Number(right);
    if (operator === ">=") return Number(doc[field]) >= Number(right);
    if (operator === "<=") return Number(doc[field]) <= Number(right);
    throw new Error("Unsupported fixture filter");
  };
  const and = (): boolean => { let result = atom(); while (tokens[position] === "and") { take(); const next = atom(); result = result && next; } return result; };
  const or = (): boolean => { let result = and(); while (tokens[position] === "or") { take(); const next = and(); result = result || next; } return result; };
  const result = or();
  if (position !== tokens.length) throw new Error("Unconsumed fixture filter");
  return result;
}

const iso = { teamId: "t1", userId: "u1", agentId: "a1" };
const rec = (id: string, sources: string[] = []): MemoryRecord => ({
  id, content: `kubernetes ${id}`, type: "work_fact", priority: 50, scene_name: "default", source_message_ids: [],
  metadata: {}, timestamps: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  sessionKey: "sk", sessionId: "ses", ...iso, review_sources: sources,
});

describe("TCVDB review through the HTTP client contract", () => {
  let server: http.Server;
  let store: TcvdbMemoryStore;
  let peer: TcvdbMemoryStore;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let unstable = false;
  let queryTurn = 0;
  let indexStatus = "ready";
  const indexes: Array<Record<string, unknown>> = [];
  const docs = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };

  function seedReceipt(event: MemoryEvent): MemoryEvent {
    event.event_id = reviewEventId(event);
    const collection = (store as unknown as { eventsCollection: string }).eventsCollection;
    docs(collection).set(event.event_id, { ...event, id: event.event_id, supersedes: JSON.stringify(event.supersedes ?? []), review_json: JSON.stringify(event.review) });
    return event;
  }

  async function committedRetract(id: string, ownership = iso): Promise<MemoryEvent> {
    return seedReceipt({
      event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses",
      team_id: ownership.teamId, user_id: ownership.userId, agent_id: ownership.agentId, record_id: id,
      content: "", op: "retracted", source: "review", layer: "l1",
      review: { protocol: 2, operation_id: `rop-${newMemoryEventId().slice(4).repeat(2)}`, request_hash: "a".repeat(64), previous_status: "active" },
    });
  }

  beforeEach(async () => {
    __setMemoryReviewEnabledForTests(true);
    collections.clear(); calls.length = 0; unstable = false; queryTurn = 0; indexes.length = 0; indexStatus = "ready";
    server = http.createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Record<string, unknown>;
        calls.push({ path: req.url!, body });
        const data = docs(String(body.collection));
        const query = (body.query ?? body.search ?? {}) as Record<string, unknown>;
        const ids = query.documentIds as string[] | undefined;
        if (ids && ids.length > 20) throw new Error("documentIds limit exceeded");
        let selected = [...data.values()].filter((d) => (!ids || ids.includes(String(d.id))) && matches(d, query.filter as string | undefined));
        let response: Record<string, unknown> = {};
        if (req.url === "/collection/describe") {
          response.collection = { collection: body.collection, database: body.database, indexes, indexStatus: { status: indexStatus } };
        } else if (req.url === "/index/add") {
          indexes.push(...body.indexes as Array<Record<string, unknown>>);
        } else if (req.url === "/document/upsert") {
          for (const d of body.documents as Array<Record<string, unknown>>) data.set(String(d.id), { ...d });
        } else if (req.url === "/document/update") {
          const update = body.update as Record<string, unknown>;
          for (const d of selected) data.set(String(d.id), { ...d, ...update, ...(typeof update.text === "string" ? { vector: [update.text.length] } : {}) });
          response.affectedCount = selected.length;
        } else if (req.url === "/document/count") response.count = selected.length;
        else if (req.url === "/document/delete") {
          for (const d of selected) data.delete(String(d.id));
          response.affectedCount = selected.length;
        } else if (["/document/query", "/document/search", "/document/hybridSearch"].includes(req.url!)) {
          const sort = query.sort as Array<{ fieldName: string; direction: string }> | undefined;
          selected.sort((a, b) => {
            for (const s of sort ?? []) {
              const cmp = String(a[s.fieldName] ?? "").localeCompare(String(b[s.fieldName] ?? ""));
              if (cmp) return s.direction === "desc" ? -cmp : cmp;
            }
            return String(a.id).localeCompare(String(b.id));
          });
          if (unstable && !ids) { queryTurn++; if (queryTurn % 2 === 0) selected.reverse(); }
          selected = selected.slice(Number(query.offset ?? 0), Number(query.offset ?? 0) + Number(query.limit ?? 100));
          const fields = query.outputFields as string[] | undefined;
          const output = selected.map((d) => fields ? Object.fromEntries(Object.entries(d).filter(([k]) => fields.includes(k))) : { ...d });
          response.documents = req.url === "/document/query" ? output : [output.map((d) => ({ ...d, score: 0.9 }))];
        } else throw new Error("Unexpected fixture endpoint");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: 0, msg: "ok", ...response }));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: 999, msg: "fixture contract violation" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username: "fixture", apiKey: "fixture", database: "review", embeddingModel: "none", embeddingEnabled: true, timeout: 1000 };
    store = new TcvdbMemoryStore(config);
    peer = new TcvdbMemoryStore(config);
    expect(await store.upsertL1(rec("root"))).toBe(true);
    expect(await store.upsertL1(rec("clean"))).toBe(true);
  });

  afterEach(async () => {
    store.close(); peer.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    __setMemoryReviewEnabledForTests(undefined);
  });

  it("one L1 decoder gives identical primary, full-scan and paginated rows", async () => {
    const l1 = [...collections.values()].find((c) => c.has("root"))!;
    const old = { ...l1.get("root") }; delete old.priority;
    l1.set("root", old);
    const filter = { ...iso, visibility: "all" as const };
    const direct = (await store.queryL1Records({ ...filter, recordIds: ["root"] }))[0];
    const scanned = (await store.queryL1Records(filter)).find((r) => r.record_id === "root");
    const paginated = (await store.queryL1Paginated({ ...filter, limit: 10, offset: 0 })).rows.find((r) => r.record_id === "root");
    expect(direct.priority).toBe(0);
    expect(scanned).toEqual(direct);
    expect(paginated).toEqual(direct);
  });

  it("empty primary-key selections do not scan and raw reads still reject degradation", async () => {
    const before = calls.length;
    expect(await store.queryL1Records({ ...iso, recordIds: [] })).toEqual([]);
    expect(calls).toHaveLength(before);
    const state = store as unknown as { degraded: boolean };
    state.degraded = true;
    try { await expect(store.queryL1Records({ ...iso, visibility: "all" }, { review: false })).rejects.toThrow("degraded"); }
    finally { state.degraded = false; }
  });

  it("native TCVDB refuses new immutable commands before any event or L1 write", async () => {
    const before = calls.length;
    expect((store as IMemoryStore).setL1ReviewStatus).toBeUndefined();
    expect(calls).toHaveLength(before);
    const event: MemoryEvent = { event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", record_id: "root", layer: "l1", content: "", op: "retracted", source: "review", review: { protocol: 2, operation_id: `rop-${"a".repeat(64)}`, request_hash: "b".repeat(64), previous_status: "active" } };
    event.event_id = reviewEventId(event);
    await expect(store.appendMemoryEvent(event)).rejects.toBeInstanceOf(ReviewCapabilityError);
    expect(calls).toHaveLength(before);
    expect((await peer.queryL1Records(iso)).map((r) => r.record_id)).toEqual(["clean", "root"]);
  });

  it("imported committed retraction reaches reads, pagination, count and texts on another instance", async () => {
    const retract = await committedRetract("root");
    expect((await peer.queryL1Records(iso)).map((r) => r.record_id)).toEqual(["clean"]);
    expect(await peer.countL1(iso)).toBe(1);
    expect((await peer.searchL1Hybrid({ query: "kubernetes", topK: 2, filter: iso })).map((r) => r.record_id)).toEqual(["clean"]);
    expect((await peer.queryL1Paginated({ ...iso, visibility: "quarantined", limit: 10, offset: 0 })).rows[0]?.record_id).toBe("root");
    expect((await peer.getAllL1Texts()).map((r) => r.record_id)).toEqual(["clean"]);
    expect((peer as IMemoryStore).setL1ReviewStatus).toBeUndefined();
    seedReceipt({ ...retract, op: "restored", review: { ...retract.review!, operation_id: `rop-${"c".repeat(64)}`, previous_status: "quarantined", observed: [retract.review!.operation_id!] } });
    expect(await store.countL1(iso)).toBe(2);
  });

  it("default ownership buckets round-trip through the same review protocol", async () => {
    const defaults = { teamId: "default", userId: "default", agentId: "default" };
    expect(await store.upsertL1({ ...rec("default-root"), teamId: undefined, userId: undefined, agentId: undefined })).toBe(true);
    expect((await peer.queryL1Records(defaults)).map((r) => r.record_id)).toEqual(["default-root"]);
    await committedRetract("default-root", defaults);
    expect(await store.queryL1Records(defaults)).toEqual([]);
  });

  it("review does not rewrite L1 vectors and ordinary updates preserve unknown fields", async () => {
    const l1 = [...collections.values()].find((c) => c.has("root"))!;
    l1.set("root", { ...l1.get("root"), vector: [7, 9], private_extra: "preserved" });
    const before = JSON.stringify(l1.get("root"));
    await committedRetract("root");
    expect(JSON.stringify(l1.get("root"))).toBe(before);
    expect(await peer.upsertL1({ ...rec("root"), content: "new bytes" })).toBe(true);
    expect(l1.get("root")?.vector).toEqual(["new bytes".length]);
    expect(l1.get("root")?.private_extra).toBe("preserved");
    expect((await store.queryL1Records({ ...iso, recordIds: ["root"] }))).toEqual([]);
    expect(calls.some((c) => c.path === "/document/update")).toBe(true);
  });

  it("chunked primary reads retain review lineage and old documents remain active", async () => {
    const batch = Array.from({ length: 25 }, (_, i) => rec(`m_${i}`));
    expect(await store.upsertL1Batch(batch)).toBe(25);
    expect((await store.queryL1Records({ ...iso, recordIds: batch.map((r) => r.id), visibility: "all" })).length).toBe(25);
    await store.upsertL1(rec("child", ["root"]));
    await committedRetract("root");
    expect(await store.queryL1Records({ ...iso, recordIds: ["child"] })).toEqual([]);
    const l1 = [...collections.values()].find((c) => c.has("clean"))!;
    const old = { ...l1.get("clean") }; delete old.review_status; delete old.review_sources_json;
    l1.set("clean", old);
    expect((await store.queryL1Records({ ...iso, recordIds: ["clean"] }))[0]?.record_id).toBe("clean");
  });

  it("a clear between preflight and acknowledged upsert removes only the invalidated generation", async () => {
    const client = (store as unknown as { client: TcvdbClient }).client;
    const upsert = client.upsert.bind(client);
    const guard = "2026-01-01T00:00:00.000Z";
    vi.spyOn(client, "upsert").mockImplementationOnce(async (collection, batch) => {
      await peer.appendMemoryEvent({ event_ts: "2026-01-02T00:00:00.000Z", session_key: "", session_id: "", team_id: "t1", agent_id: "a1", record_id: "clear", content: "", op: "deleted", scope: "agent", layer: "l1", source: "api_mutation" });
      await upsert(collection, batch);
    });
    expect(await store.upsertL1({ ...rec("late"), review_guard_at: guard })).toBe(false);
    expect(await peer.queryL1Records({ ...iso, recordIds: ["late"], visibility: "all" })).toEqual([]);
    expect(calls.find((c) => c.path === "/document/delete")?.body.query).toMatchObject({ documentIds: ["late"], filter: `review_guard_at = "${guard}"` });
  });

  it("CAS rejects a stale source-list update instead of losing concurrent lineage", async () => {
    await store.upsertL1(rec("left"));
    await store.upsertL1(rec("right"));
    const client = (store as unknown as { client: TcvdbClient }).client;
    const update = client.update.bind(client);
    vi.spyOn(client, "update").mockImplementationOnce(async (collection, params) => {
      expect(await peer.upsertL1(rec("root", ["right"]))).toBe(true);
      return update(collection, params);
    });
    expect(await store.upsertL1(rec("root", ["left"]))).toBe(false);
    const row = (await peer.queryL1Records({ ...iso, recordIds: ["root"], visibility: "all" }, { review: false }))[0]!;
    expect(JSON.parse(row.review_sources_json!)).toEqual(["right"]);
    expect(row.version).toBe(1);
  });

  it("upgrades existing scalar indexes, but fails closed during their build", async () => {
    const client = (store as unknown as { client: TcvdbClient }).client;
    const required = [{ fieldName: "scope", fieldType: "string", indexType: "filter" as const }];
    await client.ensureFilterIndexes("events", required);
    expect(calls.find((c) => c.path === "/index/add")?.body).toMatchObject({ indexes: required, buildExistedData: true });
    const added = calls.filter((c) => c.path === "/index/add").length;
    await client.ensureFilterIndexes("events", required);
    expect(calls.filter((c) => c.path === "/index/add")).toHaveLength(added);
    indexStatus = "building";
    await expect(client.ensureFilterIndexes("events", required)).rejects.toThrow("not ready");
  });

  it("review resolution scans a multi-page event window only once", async () => {
    const event = await committedRetract("root");
    const collection = (store as unknown as { eventsCollection: string }).eventsCollection;
    const data = docs(collection);
    const original = data.get(event.event_id!)!;
    for (let i = 0; i < 1201; i++) {
      const id = newMemoryEventId();
      data.set(id, { ...original, id, event_id: id, op: "created", source: "extraction", review_json: "" });
    }
    calls.length = 0;
    expect(await peer.queryL1Records({ ...iso, recordIds: ["root"] })).toEqual([]);
    expect(calls.filter((call) => call.path === "/document/count" && call.body.collection === collection && String((call.body.query as Record<string, unknown>).filter).includes("record_id in"))).toHaveLength(1);
  });

  it("a server-side paging tie omission is rejected, not reported as complete history", async () => {
    const event: MemoryEvent = { event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk", session_id: "ses", team_id: "t1", user_id: "u1", agent_id: "a1", record_id: "root", content: "", op: "created", source: "extraction" };
    for (let i = 0; i < 201; i++) await store.appendMemoryEvent({ ...event, event_id: `evt-${i.toString(16).padStart(32, "0")}` });
    unstable = true;
    await expect(store.queryMemoryEvents({ record_id: "root", limit: 1000 })).rejects.toThrow(/incomplete|concurrently/);
  });
});
