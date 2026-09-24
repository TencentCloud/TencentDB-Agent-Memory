/**
 * POST /v2|v3/memory/diff — session 变更集聚合端点测试。
 *
 * 覆盖：
 *  - created → { op, record, replaced: [] }
 *  - updated → 新记录 + replaced[]（superseded 快照 join，含 origin_session_id）
 *  - orphan superseded（其 superseded_by 不在事件流）单独成组
 *  - op 过滤发生在事件层
 *  - 租户隔离：跨 team 查询返回空；v3 缺三元组 → 422
 *  - 缺 session_id → 400；store 不支持 queryMemoryEvents → 501
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "../core/store/sqlite/memory-store.js";
import { writeMemory, type DedupDecision, type ExtractedMemory } from "../core/record/l1-writer.js";
import { handleV2Route } from "./v2-router.js";

const memory = (content: string): ExtractedMemory => ({
  content, type: "work_fact", priority: 50,
  source_message_ids: [], metadata: {}, scene_name: "default",
});
const decision = (record_id: string, action: DedupDecision["action"], target_ids: string[] = [], merged_content?: string): DedupDecision => ({
  record_id, action, target_ids, merged_content,
});

const ISO_HEADERS = {
  authorization: "Bearer test-key",
  "x-tdai-service-id": "svc",
  "x-tdai-team-id": "t1",
  "x-tdai-agent-id": "a1",
  "x-tdai-user-id": "u1",
};

describe("POST /memory/diff", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: { changes: Array<Record<string, unknown>>; count: number; has_more: boolean; next_offset: number } } } | null;
  const writtenFiles = new Map<string, string>();

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as NonNullable<typeof captured>["body"] };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({
        appendFile: async (key: string, content: string) => {
          writtenFiles.set(key, (writtenFiles.get(key) ?? "") + content + "\n");
        },
      }) as never,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    const handled = await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as ({ status: number; body: { code: number; data?: { changes: Array<Record<string, unknown>>; count: number; has_more: boolean; next_offset: number } } } | null);
    return { handled, status: cap?.status, data: cap?.body?.data };
  };

  const writeIso = { sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-diff-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    // ses-x creates m_a; ses-y supersedes it with m_b.
    await writeMemory({ ...writeIso, baseDir: dir, vectorStore: store, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    await writeMemory({ ...writeIso, sessionId: "ses-y", baseDir: dir, vectorStore: store, memory: memory("salary 6000"), decision: decision("m_b", "update", ["m_a"], "salary 6000") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groups updated event with its superseded snapshot", async () => {
    const { status, data } = await call("/v3/memory/diff", { session_id: "ses-y" });
    expect(status).toBe(200);
    expect(data!.changes).toHaveLength(1);
    expect(data!.changes[0]).toMatchObject({ op: "updated", record_id: "m_b", content: "salary 6000" });
    const replaced = data!.changes[0].replaced as Array<Record<string, unknown>>;
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ record_id: "m_a", content: "salary 5000", origin_session_id: "ses-x" });
  });

  it("created change has empty replaced", async () => {
    const { data } = await call("/v3/memory/diff", { session_id: "ses-x" });
    const created = data!.changes.filter((c) => c.op === "created");
    expect(created).toHaveLength(1);
    expect(created[0].record_id).toBe("m_a");
    expect(created[0].replaced).toEqual([]);
  });

  it("surfaces orphan superseded rows as standalone changes", async () => {
    store.appendMemoryEvent({
      event_ts: "2026-01-02T00:00:00Z", session_key: "sk-x", session_id: "ses-x",
      team_id: "t1", user_id: "u1", agent_id: "a1",
      op: "superseded", record_id: "m_orph", content: "old", superseded_by: "m_ghost",
    });
    const { data } = await call("/v3/memory/diff", { session_id: "ses-x" });
    const orphan = data!.changes.find((c) => c.record_id === "m_orph");
    expect(orphan).toMatchObject({ op: "superseded", content: "old" });
  });

  it("exposes event-level pagination fields", async () => {
    const { status, data } = await call("/v3/memory/diff", { session_id: "ses-y", limit: 1 });
    expect(status).toBe(200);
    // ses-y has 2 raw events (superseded + updated) → limit 1 must paginate.
    expect(data!.has_more).toBe(true);
    expect(data!.next_offset).toBe(1);
    expect(data!.count).toBe(data!.changes.length);
  });

  it("returns nothing for a different tenant", async () => {
    const { data } = await call("/v3/memory/diff", { session_id: "ses-y" }, { ...ISO_HEADERS, "x-tdai-team-id": "t2" });
    expect(data!.changes).toHaveLength(0);
  });

  it("rejects /v3 without the isolation triple", async () => {
    const { status } = await call("/v3/memory/diff", { session_id: "ses-y" }, {
      authorization: "Bearer k", "x-tdai-service-id": "svc",
    });
    expect(status).toBe(422);
  });

  it("rejects missing session_id", async () => {
    const { status } = await call("/v3/memory/diff", {});
    expect(status).toBe(400);
  });

  it("also serves /v2/memory/diff", async () => {
    const { status, data } = await call("/v2/memory/diff", { session_id: "ses-y" });
    expect(status).toBe(200);
    expect(data!.changes).toHaveLength(1);
  });

  it("op filter applies at the event layer", async () => {
    // ses-y has superseded(m_a) + updated(m_b). op=updated drops the
    // superseded row → the updated change has no replaced[] join target.
    const { status, data } = await call("/v3/memory/diff", { session_id: "ses-y", op: "updated" });
    expect(status).toBe(200);
    expect(data!.changes).toHaveLength(1);
    expect(data!.changes[0]).toMatchObject({ op: "updated", record_id: "m_b" });
    expect(data!.changes[0].replaced).toEqual([]);

    const created = await call("/v3/memory/diff", { session_id: "ses-y", op: "created" });
    expect(created.data!.changes).toHaveLength(0);
  });

  it("since/until bound the event window", async () => {
    const all = await call("/v3/memory/diff", { session_id: "ses-y", since: "2000-01-01T00:00:00Z" });
    expect(all.data!.changes.length).toBeGreaterThan(0);
    const empty = await call("/v3/memory/diff", { session_id: "ses-y", until: "2000-01-01T00:00:00Z" });
    expect(empty.data!.changes).toHaveLength(0);
  });
});

describe("POST /memory/diff/revert", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown>; message?: string } } | null;
  const writtenFiles = new Map<string, string>();

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as NonNullable<typeof captured>["body"] };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({
        appendFile: async (key: string, content: string) => {
          writtenFiles.set(key, (writtenFiles.get(key) ?? "") + content + "\n");
        },
      }) as never,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as ({ status: number; body: { code: number; data?: Record<string, unknown> } } | null);
    return { status: cap?.status, data: cap?.body?.data };
  };

  const writeIso = { sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-revert-"));
    writtenFiles.clear();
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    await writeMemory({ ...writeIso, baseDir: dir, vectorStore: store, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    await writeMemory({ ...writeIso, sessionId: "ses-y", baseDir: dir, vectorStore: store, memory: memory("salary 6000"), decision: decision("m_b", "update", ["m_a"], "salary 6000") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reverts an updated change: deletes new record, restores snapshot, marks diff", async () => {
    const { status, data } = await call("/v3/memory/diff/revert", { record_id: "m_b", reason: "wrong" });
    expect(status).toBe(200);
    expect(data).toMatchObject({ record_id: "m_b", reverted: true, restored: ["m_a"] });

    // New record deleted, old restored.
    const remaining = await store.queryL1Records({ recordIds: ["m_a", "m_b"] });
    expect(remaining.map((r) => r.record_id)).toEqual(["m_a"]);

    // reverted event carries the reviewer identity (isolation user).
    const reverted = store.queryMemoryEvents({ record_id: "m_b", op: "reverted" });
    expect(reverted).toHaveLength(1);
    expect(reverted[0].reviewer_id).toBe("u1");
    expect(reverted[0].session_id).toBe("ses-y"); // attributed to original session

    // diff view marks the change reverted and exposes the reviewer.
    const diff = await call("/v3/memory/diff", { session_id: "ses-y" });
    const change = ((diff.data?.changes ?? []) as Array<Record<string, unknown>>).find((c) => c.record_id === "m_b");
    expect(change).toMatchObject({ reverted: true, reverted_by: "u1" });
  });

  it("appends a JSONL tombstone so replay cannot resurrect the record", async () => {
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    const tombstoneLines = [...writtenFiles.values()]
      .flatMap((v) => v.split("\n"))
      .filter((l) => l.includes('"tombstone":"l1"'));
    expect(tombstoneLines).toHaveLength(1);
    const tomb = JSON.parse(tombstoneLines[0]);
    expect(tomb).toMatchObject({ record_id: "m_b", reviewer_id: "u1" });
  });

  it("second revert is idempotent → 409", async () => {
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    const second = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(second.status).toBe(409);
  });

  it("unknown record → 404", async () => {
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_nope" });
    expect(status).toBe(404);
  });

  it("cross-tenant revert is blocked (iso scope mismatch → 404)", async () => {
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_b" }, { ...ISO_HEADERS, "x-tdai-team-id": "t2" });
    expect(status).toBe(404);
  });

  it("batch revert returns per-item results; one failure does not block others", async () => {
    const { status, data } = await call("/v3/memory/diff/revert", { record_ids: ["m_b", "m_nope"] });
    expect(status).toBe(200);
    expect(data).toMatchObject({ succeeded: 1, failed: 1 });
    const results = data!.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ record_id: "m_b", reverted: true, restored: ["m_a"] });
    expect(results[1]).toMatchObject({ record_id: "m_nope", reverted: false, status: 404 });
  });

  it("batch revert surfaces 409 per item for already-reverted records", async () => {
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    const { data } = await call("/v3/memory/diff/revert", { record_ids: ["m_b", "m_a"] });
    const results = data!.results as Array<Record<string, unknown>>;
    // m_b already reverted → 409; m_a was restored by the first revert → its
    // last write event is still 'created' → can be reverted (deletes it).
    expect(results[0]).toMatchObject({ record_id: "m_b", reverted: false, status: 409 });
    expect(results[1]).toMatchObject({ record_id: "m_a", reverted: true });
  });

  it("rejects a batch exceeding 50 ids", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `m_${i}`);
    const { status } = await call("/v3/memory/diff/revert", { record_ids: ids });
    expect(status).toBe(400);
  });

  it("rejects an empty revert request", async () => {
    const { status } = await call("/v3/memory/diff/revert", { reason: "x" });
    expect(status).toBe(400);
  });
});

describe("POST /memory/history", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown> } } | null;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as NonNullable<typeof captured>["body"] };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({
        appendFile: async () => {},
      }) as never,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as ({ status: number; body: { code: number; data?: Record<string, unknown> } } | null);
    return { status: cap?.status, data: cap?.body?.data };
  };

  const writeIso = { sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-history-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    await writeMemory({ ...writeIso, baseDir: dir, vectorStore: store, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    await writeMemory({ ...writeIso, sessionId: "ses-y", baseDir: dir, vectorStore: store, memory: memory("salary 6000"), decision: decision("m_b", "update", ["m_a"], "salary 6000") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the full lineage of a record in time order", async () => {
    const { status, data } = await call("/v3/memory/history", { record_id: "m_b" });
    expect(status).toBe(200);
    const events = data!.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.op)).toEqual(["updated"]);
    expect(events[0]).toMatchObject({ record_id: "m_b", session_id: "ses-y", supersedes: ["m_a"] });
  });

  it("superseded record shows who replaced it", async () => {
    const { data } = await call("/v3/memory/history", { record_id: "m_a" });
    const events = data!.events as Array<Record<string, unknown>>;
    const ops = events.map((e) => e.op);
    expect(ops).toContain("created");
    expect(ops).toContain("superseded");
    const sup = events.find((e) => e.op === "superseded");
    expect(sup).toMatchObject({ superseded_by: "m_b", session_id: "ses-y", origin_session_id: "ses-x" });
  });

  it("revert appends a reverted event to the lineage", async () => {
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    const { data } = await call("/v3/memory/history", { record_id: "m_b" });
    const ops = (data!.events as Array<Record<string, unknown>>).map((e) => e.op);
    expect(ops).toEqual(["updated", "reverted"]);
  });

  it("cross-tenant history returns empty", async () => {
    const { data } = await call("/v3/memory/history", { record_id: "m_b" }, { ...ISO_HEADERS, "x-tdai-team-id": "t2" });
    expect(data!.events).toHaveLength(0);
  });

  it("rejects missing record_id", async () => {
    const { status } = await call("/v3/memory/history", {});
    expect(status).toBe(400);
  });
});

describe("POST /memory/review/inbox", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown> } } | null;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as NonNullable<typeof captured>["body"] };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({
        appendFile: async () => {},
      }) as never,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as ({ status: number; body: { code: number; data?: Record<string, unknown> } } | null);
    return { status: cap?.status, data: cap?.body?.data };
  };

  const writeIso = { sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-inbox-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    await writeMemory({ ...writeIso, baseDir: dir, vectorStore: store, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    await writeMemory({ ...writeIso, sessionId: "ses-y", baseDir: dir, vectorStore: store, memory: memory("salary 6000"), decision: decision("m_b", "update", ["m_a"], "salary 6000") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates sessions across the tenant without needing a session_id", async () => {
    const { status, data } = await call("/v3/memory/review/inbox", {});
    expect(status).toBe(200);
    const sessions = data!.sessions as Array<Record<string, unknown>>;
    const bySid = new Map(sessions.map((s) => [s.session_id, s]));
    // ses-x: 1 created; ses-y: 1 updated (its superseded row is part of the
    // updated change, not an independent change — but counts in by_op).
    expect(bySid.get("ses-x")).toMatchObject({ changes: 1, has_reverted: false });
    expect(bySid.get("ses-y")).toMatchObject({ changes: 1, has_reverted: false });
    expect((bySid.get("ses-y")!.by_op as Record<string, number>).superseded).toBe(1);
  });

  it("marks sessions containing reverted events", async () => {
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    const { data } = await call("/v3/memory/review/inbox", {});
    const sesY = (data!.sessions as Array<Record<string, unknown>>).find((s) => s.session_id === "ses-y");
    expect(sesY).toMatchObject({ has_reverted: true });
  });

  it("scopes to the tenant — other teams see nothing", async () => {
    const { data } = await call("/v3/memory/review/inbox", {}, { ...ISO_HEADERS, "x-tdai-team-id": "t2" });
    expect(data!.sessions).toHaveLength(0);
  });

  it("until filter bounds the scan window", async () => {
    const { data } = await call("/v3/memory/review/inbox", { until: "2000-01-01T00:00:00Z" });
    expect(data!.sessions).toHaveLength(0);
  });
});
