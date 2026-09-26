/**
 * 变更账 JSONL outbox：先写 outbox 再写 store；store 失败时记入健康度，
 * 事后可从 outbox 幂等回放补齐。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { StorageAdapter } from "../storage/adapter.js";
import { createLocalStorageBackend } from "../storage/factory.js";
import { StoragePaths } from "../storage/types.js";
import type { IMemoryStore, MemoryEvent, MemoryEventRedactFilter } from "../store/types.js";
import { appendLedgerEvent, getLedgerHealth, getLedgerWriterId, hasPendingLedgerEvent, loadLedgerWriterId, newLedgerWriterId, redactLedgerEvents, replayLedgerEvents, resetLedgerHealth, setLedgerWriterId } from "./event-ledger.js";
import { LocalMemoryCleaner } from "../../utils/memory-cleaner.js";
import { canonIsoTs, canonLegacyUntil } from "../store/memory-event-id.js";
import { writeMemory, type DedupDecision, type ExtractedMemory } from "./l1-writer.js";

const silent = { warn() {}, debug() {} };

const memory = (content: string): ExtractedMemory => ({
  content, type: "work_fact", priority: 50,
  source_message_ids: [], metadata: {}, scene_name: "default",
});
const decision = (record_id: string, action: DedupDecision["action"], target_ids: string[] = [], merged_content?: string): DedupDecision => ({
  record_id, action, target_ids, merged_content,
});

const ev = (over: Partial<MemoryEvent> = {}): MemoryEvent => ({
  event_ts: "2026-03-01T10:00:00.000Z", session_key: "sk", session_id: "ses",
  team_id: "t1", agent_id: "a1", op: "created", record_id: "m_x", content: "v1", ...over,
});

/** Contract-shaped event ids — fixtures must survive replay's shape validation. */
const eid = (n: number): string => `evt-${n.toString(16).padStart(32, "0")}`;

describe("event ledger outbox", () => {
  let dir: string;
  let store: VectorStore;
  let storage: StorageAdapter;

  beforeEach(() => {
    setLedgerWriterId(undefined);
    dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    storage = new StorageAdapter(createLocalStorageBackend(path.join(dir, "data")));
  });

  afterEach(() => {
    setLedgerWriterId(newLedgerWriterId());
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const outboxLines = async (date = "2026-03-01") =>
    ((await storage.readFile(StoragePaths.event(date))) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as MemoryEvent);

  it("writes the same event_id to the outbox and the store", async () => {
    const r = await appendLedgerEvent({ store, storage, event: ev(), logger: silent });
    expect(r.jsonl).toBe(true);
    expect(r.store).toBe(true);
    const lines = await outboxLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.event_id).toBe(r.event_id);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.event_id).toBe(r.event_id);
  });

  it("store failure keeps the outbox line, marks the ledger degraded, and backfill recovers it", async () => {
    const failing = {
      appendMemoryEvent: () => { throw new Error("vdb down"); },
    } as unknown as IMemoryStore;
    const r = await appendLedgerEvent({ store: failing, storage, event: ev(), logger: silent });
    expect(r.jsonl).toBe(true);
    expect(r.store).toBe(false);
    const h = getLedgerHealth(failing);
    expect(h.degraded).toBe(true);
    expect(h.store_failures).toBe(1);

    const first = await replayLedgerEvents({ store, storage, logger: silent });
    expect(first).toMatchObject({ files: 1, scanned: 1, replayed: 1, malformed: 0, failed: 0 });
    // Replaying again is a no-op: event_id dedup.
    await replayLedgerEvents({ store, storage, logger: silent });
    const events = store.queryMemoryEvents({ record_id: "m_x" });
    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toBe(r.event_id);
  });

  it("outbox failure does not block the store write", async () => {
    const brokenStorage = { appendFile: async () => { throw new Error("cos 503"); } } as unknown as StorageAdapter;
    const r = await appendLedgerEvent({ store, storage: brokenStorage, event: ev(), logger: silent });
    expect(r.jsonl).toBe(false);
    expect(r.store).toBe(true);
    expect(getLedgerHealth(store).jsonl_failures).toBe(1);
    expect(getLedgerHealth(store).degraded).toBe(false);
  });

  it("backfill honours since and tenant scope, and counts malformed lines", async () => {
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_old", event_ts: "2026-02-01T00:00:00.000Z" }), logger: silent });
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_new" }), logger: silent });
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_other", team_id: "t2" }), logger: silent });
    await storage.appendFile(StoragePaths.event("2026-03-01"), "{not json\n");

    const r = await replayLedgerEvents({ store, storage, since: "2026-03-01T00:00:00.000Z", scope: { team_id: "t1" }, logger: silent });
    expect(r).toMatchObject({ files: 1, replayed: 1, skipped: 1, malformed: 1 });
    expect(store.queryMemoryEvents({ limit: 10 }).map((e) => e.record_id)).toEqual(["m_new"]);
  });

  it("non-object outbox rows count as malformed without stopping later rows or shards", async () => {
    await storage.appendFile(StoragePaths.event("2026-03-01"), "null\n42\n\"str\"\n[1,2]\n");
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_a" }), logger: silent });
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_b", event_ts: "2026-03-02T00:00:00.000Z" }), logger: silent });

    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r).toMatchObject({ files: 2, scanned: 6, replayed: 2, malformed: 4, failed: 0 });
    expect(store.queryMemoryEvents({ limit: 10 }).map((e) => e.record_id)).toEqual(["m_a", "m_b"]);
  });

  it("rows with non-string content or isolation ids are malformed, never coerced into the store", async () => {
    const good = ev({ event_id: eid(1) });
    await storage.appendFile(StoragePaths.event("2026-03-01"), [
      JSON.stringify({ ...good, event_id: eid(2), team_id: 123 }),
      JSON.stringify({ ...good, event_id: eid(3), content: { secret: "p" } }),
      JSON.stringify({ ...good, event_id: eid(4), session_key: 5 }),
      JSON.stringify({ ...good, event_id: eid(5), content: undefined }),
      // Non-string-typed fields are shape-checked too: a scalar supersedes
      // would crash the diff join iteration, a string version breaks compares.
      JSON.stringify({ ...good, event_id: eid(6), supersedes: 5 }),
      JSON.stringify({ ...good, event_id: eid(7), supersedes: "m_a" }),
      JSON.stringify({ ...good, event_id: eid(8), version: "v3" }),
      JSON.stringify(good),
    ].join("\n") + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r).toMatchObject({ scanned: 8, replayed: 1, malformed: 7, failed: 0 });
    expect(store.queryMemoryEvents({}).map((e) => e.event_id)).toEqual([eid(1)]);
  });

  it("rows with an unknown op or unparseable fields are malformed, not store failures", async () => {
    const good = ev({ event_id: eid(1) });
    await storage.appendFile(StoragePaths.event("2026-03-01"), [
      JSON.stringify({ ...good, event_id: eid(7), op: "exploded" }),
      JSON.stringify({ ...good, event_id: eid(8), event_ts: "yesterday" }),
      JSON.stringify({ ...good, event_id: "evt-not32hex" }),
      JSON.stringify({ ...good, event_id: 7 }),
      JSON.stringify(good),
    ].join("\n") + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r).toMatchObject({ scanned: 5, replayed: 1, malformed: 4, failed: 0 });
  });

  it("append normalizes missing isolation ids to 'default' (task stays absent)", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ team_id: undefined, agent_id: undefined, user_id: undefined, task_id: "" }), logger: silent });
    const row = store.queryMemoryEvents({ record_id: "m_x" })[0]!;
    expect(row).toMatchObject({ team_id: "default", agent_id: "default", user_id: "default" });
    expect(row.task_id).toBeUndefined();
  });

  it("a caller-supplied event_id outside the contract shape is re-minted", async () => {
    const r = await appendLedgerEvent({ store, storage, event: ev({ event_id: "not-an-evt" }), logger: silent });
    expect(r.event_id).toMatch(/^evt-[0-9a-f]{32}$/);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.event_id).toBe(r.event_id);
  });

  it("a redact marker smuggling an unknown field counts malformed and erases nothing", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret" }), logger: silent });
    await storage.appendFile(StoragePaths.event("2026-03-01"),
      JSON.stringify({ redact: { team_id: "t1", agent_id: "a1", task_id: "tk", until: "2026-12-31T00:00:00.000Z" }, marker_ts: "2026-03-01T10:00:01.000Z" }) + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r.malformed).toBe(1);
    // 被拒的 marker 未注册：同范围后续 append 仍是明文，历史行也未被骨架化。
    await appendLedgerEvent({ store, storage, event: ev({ record_id: "m_after", content: "still" }), logger: silent });
    expect(store.queryMemoryEvents({ record_id: "m_after" })[0]!.content).toBe("still");
    expect(await storage.readFile(StoragePaths.event("2026-03-01"))).toContain("secret");
  });

  it("a '' team_id redact filter heals to 'default' — marker, registry and wipe agree", async () => {
    // 无 team 归属的事件写入后落 "default"；一个带 "" 的 filter 语义相同——
    // marker、注册表与 store 擦除必须命中同一批行，回放时覆盖关系才成立。
    await appendLedgerEvent({ store, storage, event: ev({ team_id: undefined, content: "secret" }), logger: silent });
    const res = await redactLedgerEvents({ store, storage, logger: silent,
      filter: { team_id: "", until: "2026-12-31T00:00:00.000Z" } });
    expect(res.redacted).toBe(1);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    // marker 写出的是愈合后的形态——回放按 "default" 覆盖，行为一致
    const names = await storage.readdirNames("events/", ".jsonl");
    const raw = (await Promise.all(names.map((n) => storage.readFile(`events/${n}`)))).join("");
    expect(raw).toContain('"team_id":"default"');
    // 注册表同形态覆盖：redact 之后无 team 归属的写入只能落骨架
    await appendLedgerEvent({ store, storage, event: ev({ record_id: "m_after", team_id: undefined, content: "later" }), logger: silent });
    expect(store.queryMemoryEvents({ record_id: "m_after" })[0]!.content).toBe("");
  });

  it("a foreign marker carrying '' ids still covers 'default'-normalized events", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ team_id: undefined, content: "secret" }), logger: silent });
    await storage.appendFile(StoragePaths.event("2026-03-02"),
      JSON.stringify({ redact: { team_id: "", agent_id: "a1", until: "2026-12-31T00:00:00.000Z" }, marker_ts: "2026-03-02T00:00:01.000Z" }) + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r.redactions_applied).toBe(1);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
  });

  it("redactLedgerEvents refuses a filter carrying an unknown field — no wipe, no marker", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret" }), logger: silent });
    const res = await redactLedgerEvents({ store, storage, logger: silent,
      filter: { team_id: "t1", agent_id: "a1", task_id: "tk", until: "2026-12-31T00:00:00.000Z" } as never });
    expect(res).toMatchObject({ jsonl: false });
    expect(res.redacted).toBeUndefined();
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("secret");
    expect(await storage.readFile(StoragePaths.event("2026-03-01"))).not.toContain('"redact"');
  });

  it("a failed store redaction degrades the ledger until backfill re-applies the marker", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret", snapshot_json: "{\"content\":\"secret\"}" }), logger: silent });
    const realRedact = store.redactMemoryEvents.bind(store);
    store.redactMemoryEvents = () => { throw new Error("db locked"); };
    const filter = { team_id: "t1", agent_id: "a1", until: "2026-12-31T00:00:00.000Z" };
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    const scope = { team_id: "t1", agent_id: "a1" };
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_redactions: 1 });
    expect(getLedgerHealth(store, { team_id: "t2", agent_id: "a1" })).toMatchObject({ degraded: false, pending_redactions: 0 });
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("secret");

    store.redactMemoryEvents = realRedact;
    const r = await replayLedgerEvents({ store, storage, scope, logger: silent });
    expect(r).toMatchObject({ redactions_applied: 1, failed: 0 });
    const [row] = store.queryMemoryEvents({ record_id: "m_x" });
    expect(row!.content).toBe("");
    expect(row!.snapshot_json).toBeUndefined();
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: false, pending_redactions: 0 });
  });

  it("a failed unscoped (TTL) redaction clears per tenant as each tenant backfills", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "a" }), logger: silent });
    await appendLedgerEvent({ store, storage, event: ev({ team_id: "t2", record_id: "m_y", content: "b" }), logger: silent });
    const realRedact = store.redactMemoryEvents.bind(store);
    store.redactMemoryEvents = () => { throw new Error("db locked"); };
    await redactLedgerEvents({ store, storage, filter: { until: "2026-12-31T00:00:00.000Z" }, logger: silent });
    store.redactMemoryEvents = realRedact;
    const t1 = { team_id: "t1", agent_id: "a1" };
    const t2 = { team_id: "t2", agent_id: "a1" };
    expect(getLedgerHealth(store, t1).pending_redactions).toBe(1);
    expect(getLedgerHealth(store, t2).pending_redactions).toBe(1);

    await replayLedgerEvents({ store, storage, scope: t1, logger: silent });
    expect(getLedgerHealth(store, t1)).toMatchObject({ degraded: false, pending_redactions: 0 });
    expect(getLedgerHealth(store, t2).pending_redactions).toBe(1);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    expect(store.queryMemoryEvents({ record_id: "m_y" })[0]!.content).toBe("b");

    await replayLedgerEvents({ store, storage, logger: silent });
    expect(getLedgerHealth(store, t2).pending_redactions).toBe(0);
  });

  it("replay into a store that rejects appends keeps the event pending until a real write succeeds", async () => {
    const rejecting = {
      appendMemoryEvent: async () => { throw new Error("memory_events append rejected: store is degraded"); },
    } as unknown as IMemoryStore;
    await appendLedgerEvent({ store: rejecting, storage, event: ev(), logger: silent });
    expect(getLedgerHealth(rejecting, { team_id: "t1", agent_id: "a1" })).toMatchObject({ degraded: true, pending_store_events: 1 });

    const r = await replayLedgerEvents({ store: rejecting, storage, logger: silent });
    expect(r).toMatchObject({ replayed: 0, failed: 1 });
    expect(getLedgerHealth(rejecting, { team_id: "t1", agent_id: "a1" })).toMatchObject({ degraded: true, pending_store_events: 1 });
  });

  it("append rejects an unrepresentable event_ts and normalizes ms-exact forms", async () => {
    const bad = await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-01" }), logger: silent });
    expect(bad).toMatchObject({ jsonl: false, store: false });
    expect(store.queryMemoryEvents({ record_id: "m_x" })).toHaveLength(0);

    const ok = await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-01T18:00:00+08:00" }), logger: silent });
    expect(ok).toMatchObject({ jsonl: true, store: true });
    expect((await outboxLines()).at(-1)!.event_ts).toBe("2026-03-01T10:00:00.000Z");
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.event_ts).toBe("2026-03-01T10:00:00.000Z");
  });

  it("replay normalizes foreign event_ts forms and rejects ambiguous/lossy ones", async () => {
    await storage.appendFile(StoragePaths.event("2026-03-01"), [
      JSON.stringify({ ...ev({ record_id: "m_off" }), event_ts: "2026-03-01T18:00:00+08:00", event_id: eid(2) }),
      JSON.stringify({ ...ev({ record_id: "m_noms" }), event_ts: "2026-03-01T10:00:00Z", event_id: eid(3) }),
      // Parseable garbage and zone-less instants are malformed, never stored.
      JSON.stringify({ ...ev({ record_id: "m_bad" }), event_ts: "March 1, 2026", event_id: eid(9) }),
      JSON.stringify({ ...ev({ record_id: "m_noz" }), event_ts: "2026-03-01T10:00:00", event_id: eid(10) }),
      JSON.stringify({ ...ev({ record_id: "m_us" }), event_ts: "2026-03-01T10:00:00.123456Z", event_id: eid(11) }),
    ].join("\n") + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r).toMatchObject({ replayed: 2, malformed: 3 });
    expect(store.queryMemoryEvents({ record_id: "m_off" })[0]!.event_ts).toBe("2026-03-01T10:00:00.000Z");
    expect(store.queryMemoryEvents({ record_id: "m_noms" })[0]!.event_ts).toBe("2026-03-01T10:00:00.000Z");
  });

  it("a marker's non-canonical until is normalized; a garbage until counts malformed and wipes nothing", async () => {
    await appendLedgerEvent({ store: undefined, storage, event: ev({ content: "secret" }), logger: silent });
    await storage.appendFile(StoragePaths.event("2026-03-01"), [
      // "+08:00" → 2026-12-30T16:00:00.000Z — still covers the March event.
      JSON.stringify({ redact: { team_id: "t1", agent_id: "a1", until: "2026-12-31T00:00:00+08:00" }, marker_ts: "2026-12-30T16:00:01.000Z" }),
      // A parseable-but-non-ISO until would lexically cover EVERY event row.
      JSON.stringify({ redact: { until: "March 5, 2026" }, marker_ts: "2026-03-05T00:00:00.000Z" }),
    ].join("\n") + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r.malformed).toBe(1);
    expect(r.redactions_applied).toBe(1);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
  });

  it("redactLedgerEvents rejects an unrepresentable until before any leg runs", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "keep" }), logger: silent });
    const res = await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "next tuesday" }, logger: silent });
    expect(res).toEqual({ jsonl: false });
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("keep");
    expect((await outboxLines()).filter((l) => (l as unknown as { redact?: unknown }).redact)).toHaveLength(0);
  });

  it("ledger health scope heals \"\" to \"default\" like every other isolation compare", async () => {
    const bad = await appendLedgerEvent({ store, storage, event: ev({ team_id: "", agent_id: "", event_ts: "2026-02-30T00:00:00Z" }), logger: silent });
    expect(bad.store).toBe(false);
    expect(getLedgerHealth(store, { team_id: "", agent_id: "" })).toMatchObject({ degraded: true, pending_store_events: 1 });
    expect(hasPendingLedgerEvent(store, "m_x", { team_id: "", agent_id: "" })).toBe(true);
  });

  it("a contract-rejected append or redaction degrades ledger health instead of vanishing", async () => {
    const bad = await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-02-30T00:00:00Z" }), logger: silent });
    expect(bad).toMatchObject({ jsonl: false, store: false });
    expect(getLedgerHealth(store, { team_id: "t1", agent_id: "a1" })).toMatchObject({ degraded: true, pending_store_events: 1 });
    resetLedgerHealth(store);
    await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "next tuesday" }, logger: silent });
    expect(getLedgerHealth(store, { team_id: "t1", agent_id: "a1" })).toMatchObject({ degraded: true, rejected_redactions: 1, pending_store_events: 0 });
    expect(getLedgerHealth(store, { team_id: "t2", agent_id: "a1" }).degraded).toBe(false);
    resetLedgerHealth(store);
    // An unscoped (all-tenant) rejected redaction degrades every tenant's view.
    await redactLedgerEvents({ store, storage, filter: { until: "next tuesday" }, logger: silent });
    expect(getLedgerHealth(store, { team_id: "t1", agent_id: "a1" })).toMatchObject({ degraded: true, rejected_redactions: 1 });
    expect(getLedgerHealth(store, { team_id: "t2", agent_id: "a1" }).degraded).toBe(true);
    resetLedgerHealth(store);
  });

  it("replay canonicalizes a non-canonical since before the lexical event_ts compare", async () => {
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_ms", event_ts: "2026-03-01T10:00:00.250Z" }), logger: silent });
    const r = await replayLedgerEvents({ store, storage, since: "2026-03-01T18:00:00+08:00", logger: silent });
    expect(r.replayed).toBe(1);
    expect(store.queryMemoryEvents({ record_id: "m_ms" })).toHaveLength(1);
    await expect(replayLedgerEvents({ store, storage, since: "2026-02-30T00:00:00Z", logger: silent })).rejects.toThrow(/non-canonical/);
  });

  it("legacy marker untils (sub-ms, date-only) replay with the exact canonical bound", async () => {
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_in", event_ts: "2026-03-01T10:00:00.123Z", content: "s1" }), logger: silent });
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_out", event_ts: "2026-03-01T10:00:00.124Z", content: "s2" }), logger: silent });
    await appendLedgerEvent({ store: undefined, storage, event: ev({ team_id: "t2", record_id: "m_day", event_ts: "2026-03-01T00:00:00.000Z", content: "s3" }), logger: silent });
    await storage.appendFile(StoragePaths.event("2026-03-01"), [
      JSON.stringify({ redact: { team_id: "t1", agent_id: "a1", until: "2026-03-01T10:00:00.123999Z" }, marker_ts: "2026-03-01T10:00:01.000Z" }),
      // date-only covered only events strictly before that day
      JSON.stringify({ redact: { team_id: "t2", agent_id: "a1", until: "2026-03-01" }, marker_ts: "2026-03-01T10:00:02.000Z" }),
    ].join("\n") + "\n");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r.malformed).toBe(0);
    expect(r.redactions_applied).toBe(2);
    expect(store.queryMemoryEvents({ record_id: "m_in" })[0]!.content).toBe("");
    expect(store.queryMemoryEvents({ record_id: "m_out" })[0]!.content).toBe("s2");
    expect(store.queryMemoryEvents({ record_id: "m_day" })[0]!.content).toBe("s3");
  });

  it("rebuilding a store from the outbox reproduces writeMemory's events exactly", async () => {
    const base = { sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1", baseDir: dir, vectorStore: store, storage };
    await writeMemory({ ...base, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    await writeMemory({ ...base, memory: memory("salary 6000"), decision: decision("m_b", "update", ["m_a"], "salary 6000") });
    const original = store.queryMemoryEvents({ session_id: "ses-x", limit: 10 });
    expect(original.map((e) => e.op)).toEqual(["created", "superseded", "updated"]);

    const rebuilt = new VectorStore(path.join(dir, "rebuilt.db"), 0);
    rebuilt.init();
    try {
      const r = await replayLedgerEvents({ store: rebuilt, storage, logger: silent });
      expect(r.replayed).toBe(3);
      const replayed = rebuilt.queryMemoryEvents({ session_id: "ses-x", limit: 10 });
      expect(replayed.map((e) => [e.event_id, e.op, e.record_id])).toEqual(original.map((e) => [e.event_id, e.op, e.record_id]));
      expect(replayed[1]!.snapshot_json).toBe(original[1]!.snapshot_json);
    } finally {
      rebuilt.close();
    }
  });
});

describe("event ledger in-place outbox redaction", () => {
  let dir: string;
  let store: VectorStore;
  let storage: StorageAdapter;
  const until = "2026-12-31T00:00:00.000Z";
  const filter = { team_id: "t1", agent_id: "a1", until };
  const scope = { team_id: "t1", agent_id: "a1" };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ledger-rw-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    storage = new StorageAdapter(createLocalStorageBackend(path.join(dir, "data")));
    setLedgerWriterId("w1");
  });

  afterEach(() => {
    setLedgerWriterId(newLedgerWriterId());
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const shardNames = async () => (await storage.readdirNames("events/", ".jsonl")).sort();
  const rawOutbox = async () =>
    (await Promise.all((await shardNames()).map((n) => storage.readFile(`events/${n}`)))).join("");
  const outboxRows = async () =>
    (await rawOutbox()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as MemoryEvent & { redact?: unknown; marker_ts?: string });

  it("clear rewrites historical outbox lines: plaintext gone, skeleton and markers intact", async () => {
    const snap = JSON.stringify({ content: "salary 5000" });
    const a = await appendLedgerEvent({ store, storage, event: ev({ content: "salary 5000", snapshot_json: snap, user_id: "u1", memory_type: "work" }), logger: silent });
    await appendLedgerEvent({ store, storage, event: ev({ team_id: "t2", record_id: "m_other", content: "keep me" }), logger: silent });
    await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "2026-06-01T00:00:00.000Z" }, logger: silent });
    const first = await outboxRows();
    const marker1 = first.find((r) => r.redact);
    await redactLedgerEvents({ store, storage, filter, logger: silent });

    const raw = await rawOutbox();
    expect(raw).not.toContain("salary 5000");
    expect(raw).toContain("keep me");
    expect((await shardNames()).every((n) => /^\d{4}-\d{2}-\d{2}\.w1(~[a-z0-9]+)?\.jsonl$/.test(n))).toBe(true);

    const rows = await outboxRows();
    const redacted = rows.find((r) => r.event_id === a.event_id)!;
    expect(redacted).toMatchObject({
      event_id: a.event_id, op: "created", event_ts: "2026-03-01T10:00:00.000Z", record_id: "m_x",
      team_id: "t1", agent_id: "a1", user_id: "u1", session_id: "ses", session_key: "sk", memory_type: "work", content: "",
    });
    expect(redacted.snapshot_json).toBeUndefined();
    const markers = rows.filter((r) => r.redact);
    expect(markers).toHaveLength(2);
    expect(markers).toContainEqual(marker1);
    expect(markers.map((m) => m.redact)).toContainEqual(filter);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: false, pending_redactions: 0, pending_outbox_rewrites: 0 });
  });

  it("a covered outbox line with non-string plaintext is still skeletonized", async () => {
    await storage.appendFile(StoragePaths.event("2026-03-01"),
      JSON.stringify({ ...ev({ event_id: eid(9) }), content: { secret: "salary 5000" } }) + "\n");
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    expect(await rawOutbox()).not.toContain("salary 5000");
  });

  it("persists the writer id in the data dir so a restarted process still owns its shards", async () => {
    const dataDir = path.join(dir, "plugin");
    const first = loadLedgerWriterId(dataDir);
    expect(first).toMatch(/^[A-Za-z0-9_-]+-[0-9a-f]{8}$/);
    await appendLedgerEvent({ store, storage, event: ev({ content: "before restart" }), logger: silent });
    setLedgerWriterId(newLedgerWriterId());
    expect(loadLedgerWriterId(dataDir)).toBe(first);
    expect(getLedgerWriterId()).toBe(first);
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    expect(await rawOutbox()).not.toContain("before restart");
  });

  it("a rewrite racing appends to the same shard loses neither", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "old secret" }), logger: silent });
    const appends = Array.from({ length: 20 }, (_, i) =>
      appendLedgerEvent({ store, storage, event: ev({ team_id: "t2", record_id: `m_${i}`, content: `fresh ${i}` }), logger: silent }));
    await Promise.all([redactLedgerEvents({ store, storage, filter, logger: silent }), ...appends]);
    const rows = await outboxRows();
    expect(rows.filter((r) => !r.redact)).toHaveLength(21);
    for (let i = 0; i < 20; i++) expect(rows.find((r) => r.record_id === `m_${i}`)!.content).toBe(`fresh ${i}`);
    expect(await rawOutbox()).not.toContain("old secret");
  });

  it("only rewrites this writer's shards; other writers converge on their own backfill", async () => {
    setLedgerWriterId("w2");
    await appendLedgerEvent({ store, storage, event: ev({ content: "w2 secret" }), logger: silent });
    setLedgerWriterId("w1");
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    expect(await storage.readFile("events/2026-03-01.w2.jsonl")).toContain("w2 secret");

    setLedgerWriterId("w2");
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r.outbox_redacted).toBe(1);
    expect(await rawOutbox()).not.toContain("w2 secret");
  });

  it("a failed shard rewrite degrades the ledger until backfill retries it", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret", snapshot_json: "{\"content\":\"secret\"}" }), logger: silent });
    const realAppend = storage.appendFile.bind(storage);
    storage.appendFile = async (k: string, c: string) => {
      if (k.includes("~")) throw new Error("cos 503");
      return realAppend(k, c);
    };
    const res = await redactLedgerEvents({ store, storage, filter, logger: silent });
    expect(res.jsonl).toBe(true);
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    expect(await rawOutbox()).toContain("secret\"");
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_redactions: 1, pending_outbox_rewrites: 1 });
    expect(getLedgerHealth(store, { team_id: "t2", agent_id: "a1" })).toMatchObject({ degraded: false, pending_redactions: 0 });

    // still failing: marker keeps the plaintext out of a rebuilt store, entry stays pending
    const fresh = new VectorStore(path.join(dir, "fresh.db"), 0);
    fresh.init();
    try {
      const again = await replayLedgerEvents({ store, storage, logger: silent });
      expect(again.outbox_failed).toBeGreaterThan(0);
      expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_outbox_rewrites: 1 });
      await replayLedgerEvents({ store: fresh, storage, logger: silent });
      expect(fresh.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    } finally {
      fresh.close();
    }

    storage.appendFile = realAppend;
    const r = await replayLedgerEvents({ store, storage, scope, logger: silent });
    expect(r.outbox_redacted).toBe(1);
    expect(r.outbox_failed).toBe(0);
    expect(await rawOutbox()).not.toContain("secret\"");
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: false, pending_redactions: 0, pending_outbox_rewrites: 0 });
  });

  it("degraded stays on until both the store wipe and the outbox rewrite land", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret" }), logger: silent });
    const realAppend = storage.appendFile.bind(storage);
    const realRedact = store.redactMemoryEvents.bind(store);
    storage.appendFile = async (k: string, c: string) => {
      if (k.includes("~")) throw new Error("cos 503");
      return realAppend(k, c);
    };
    store.redactMemoryEvents = () => { throw new Error("db locked"); };
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_redactions: 1, pending_outbox_rewrites: 1 });

    store.redactMemoryEvents = realRedact;
    await replayLedgerEvents({ store, storage, scope, logger: silent });
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_redactions: 1, pending_outbox_rewrites: 1 });

    storage.appendFile = realAppend;
    await replayLedgerEvents({ store, storage, scope, logger: silent });
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: false, pending_redactions: 0 });
  });

  it("a failed marker append is retried by backfill", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret" }), logger: silent });
    const realAppend = storage.appendFile.bind(storage);
    storage.appendFile = async (k: string, c: string) => {
      if (c.includes('"redact"')) throw new Error("disk full");
      return realAppend(k, c);
    };
    const res = await redactLedgerEvents({ store, storage, filter, logger: silent });
    storage.appendFile = realAppend;
    expect(res.jsonl).toBe(false);
    expect(await rawOutbox()).not.toContain("secret");
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_outbox_rewrites: 1 });
    await replayLedgerEvents({ store, storage, scope, logger: silent });
    expect((await outboxRows()).filter((r) => r.redact)).toHaveLength(1);
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: false, pending_redactions: 0 });
  });

  it("mixed legacy (unsuffixed) and per-writer shards replay and redact correctly", async () => {
    await storage.appendFile(StoragePaths.event("2026-03-01"), JSON.stringify(ev({ event_id: eid(4), record_id: "m_l", content: "legacy secret" })) + "\n");
    await storage.appendFile("events/2026-03-02.w9.jsonl", JSON.stringify(ev({ event_id: eid(5), event_ts: "2026-03-02T10:00:00.000Z", team_id: "t2", record_id: "m_o", content: "other" })) + "\n");
    await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-03T10:00:00.000Z", record_id: "m_new", content: "new" }), logger: silent });
    expect(await shardNames()).toEqual(["2026-03-01.jsonl", "2026-03-02.w9.jsonl", "2026-03-03.w1.jsonl"]);

    const fresh = new VectorStore(path.join(dir, "fresh.db"), 0);
    fresh.init();
    try {
      const r = await replayLedgerEvents({ store: fresh, storage, logger: silent });
      expect(r).toMatchObject({ files: 3, replayed: 3, malformed: 0, failed: 0 });
      expect(fresh.queryMemoryEvents({ record_id: "m_l" })[0]!.content).toBe("legacy secret");
      const since = await replayLedgerEvents({ store: fresh, storage, since: "2026-03-02T00:00:00.000Z", logger: silent });
      expect(since.files).toBe(2);
    } finally {
      fresh.close();
    }

    await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "2026-03-02T00:00:00.000Z" }, logger: silent });
    const raw = await rawOutbox();
    expect(raw).not.toContain("legacy secret");
    expect(raw).toContain("\"new\"");
    expect(raw).toContain("\"other\"");
    expect((await shardNames()).some((n) => /^2026-03-01~[a-z0-9]+\.jsonl$/.test(n))).toBe(true);
    expect(await storage.readFile("events/2026-03-02.w9.jsonl")).not.toBeNull();
  });

  it("TTL cleanup writes an unscoped retention marker and rewrites matching shard lines", async () => {
    vi.stubEnv("TZ", "UTC");
    const baseDir = path.join(dir, "data");
    // All timestamps derive from the same `now` the cleaner runs against —
    // mixing fixed dates with wall-clock new Date() makes this test expire
    // (the "live" shard eventually falls before the fixed cutoff).
    const now = Date.now();
    // retentionDays=2 keeps today + yesterday; cutoff = UTC midnight yesterday.
    const cutoff = new Date(now);
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    const cutoffMs = cutoff.getTime();
    // covered by the TTL (event_ts <= cutoff) but in a shard the cleaner keeps by name
    const oldTs = new Date(cutoffMs).toISOString();
    await appendLedgerEvent({ store, storage, event: ev({ event_id: eid(6), event_ts: oldTs, content: "expired secret" }), logger: silent });
    await appendLedgerEvent({ store, storage, event: ev({ event_ts: new Date(now).toISOString(), team_id: "t2", record_id: "m_live", content: "live" }), logger: silent });

    const ttlStore = Object.assign(Object.create(store) as IMemoryStore, {
      countL0: async () => 0,
      countL1: async () => 100,
      deleteL1Expired: async () => 3,
    });
    const cleaner = new LocalMemoryCleaner({ baseDir, retentionDays: 2, cleanTime: "03:00", vectorStore: ttlStore, logger: { info() {}, warn() {}, error() {}, debug() {} } as never });
    await cleaner.runOnce(now);
    cleaner.destroy();

    const rows = await outboxRows();
    const marker = rows.find((r) => r.redact) as { redact: { until: string; team_id?: string } } | undefined;
    expect(marker?.redact).toEqual({ until: new Date(cutoffMs).toISOString() });
    expect(rows.some((r) => r.record_id?.startsWith("retention-l1-"))).toBe(true);
    const raw = await rawOutbox();
    expect(raw).not.toContain("expired secret");
    expect(raw).toContain("\"live\"");
    expect(rows.find((r) => r.event_id === eid(6))).toMatchObject({ op: "created", record_id: "m_x", content: "" });
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
  });

  it("an append in flight when clear runs still cannot leave plaintext in store or outbox", async () => {
    // Gate the store write so the clear's filter-update lands before the
    // append's insert resolves — the clear-vs-append race that used to
    // resurrect plaintext rows.
    const realAppend = store.appendMemoryEvent.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    store.appendMemoryEvent = async (e: MemoryEvent) => { await gate; return realAppend(e); };

    const pendingAppend = appendLedgerEvent({ store, storage, event: ev({ content: "late plaintext" }), logger: silent });
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    release();
    await pendingAppend;

    // Store: post-append recheck re-applies the marker's filter-update.
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    // Outbox: the line either landed before the rewrite (skeletonized) or was
    // skeletonized inside the shard lock — plaintext never survives.
    expect(await rawOutbox()).not.toContain("late plaintext");
  });

  it("two concurrent redactions cannot leave a sealed shard un-swept", async () => {
    // Two overlapping filters share one shard; the second redaction's shard
    // snapshot can go stale behind the first seal — the global rewrite lock
    // forces a fresh listing so the sealed generation is still swept.
    await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-01T08:00:00.000Z", content: "early secret" }), logger: silent });
    await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-01T12:00:00.000Z", record_id: "m_late", content: "late secret" }), logger: silent });
    await Promise.all([
      redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "2026-03-01T10:00:00.000Z" }, logger: silent }),
      redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "2026-03-01T23:59:59.000Z" }, logger: silent }),
    ]);
    const raw = await rawOutbox();
    expect(raw).not.toContain("early secret");
    expect(raw).not.toContain("late secret");
    const rows = await outboxRows();
    expect(rows.filter((r) => r.redact)).toHaveLength(2);
  });

  it("a sequential redaction still sweeps the shard sealed by an earlier one", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-01T08:00:00.000Z", content: "early secret" }), logger: silent });
    await appendLedgerEvent({ store, storage, event: ev({ event_ts: "2026-03-01T12:00:00.000Z", record_id: "m_late", content: "late secret" }), logger: silent });
    await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until: "2026-03-01T10:00:00.000Z" }, logger: silent });
    expect((await shardNames()).some((n) => /~/.test(n))).toBe(true);
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    const raw = await rawOutbox();
    expect(raw).not.toContain("early secret");
    expect(raw).not.toContain("late secret");
  });

  it("one unreadable shard is counted as failed without aborting the replay", async () => {
    await appendLedgerEvent({ store: undefined, storage, event: ev({ record_id: "m_ok" }), logger: silent });
    await storage.appendFile("events/2026-03-02.w1.jsonl", JSON.stringify(ev({ event_ts: "2026-03-02T10:00:00.000Z", record_id: "m_late" })) + "\n");
    const realRead = storage.readFile.bind(storage);
    storage.readFile = async (key: string) => {
      if (key.includes("2026-03-02")) throw new Error("io");
      return realRead(key);
    };
    const r = await replayLedgerEvents({ store, storage, logger: silent });
    expect(r.failed).toBe(1);
    expect(r.replayed).toBe(1);
    expect(store.queryMemoryEvents({ limit: 10 }).map((e) => e.record_id)).toEqual(["m_ok"]);
  });

  it("resetLedgerHealth clears counters but never drops pending redaction work", async () => {
    await appendLedgerEvent({ store, storage, event: ev({ content: "secret" }), logger: silent });
    const realRedact = store.redactMemoryEvents.bind(store);
    store.redactMemoryEvents = () => { throw new Error("db locked"); };
    await redactLedgerEvents({ store, storage, filter, logger: silent });
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: true, pending_redactions: 1 });

    resetLedgerHealth(store);
    // Failure counters clear; the pending redaction (un-landed work) survives
    // — degraded must keep reporting it until a backfill actually lands it.
    const h = getLedgerHealth(store, scope);
    expect(h.store_failures).toBe(0);
    expect(h.pending_redactions).toBe(1);
    expect(h.degraded).toBe(true);

    // The pending wipe is still retried on the next backfill.
    store.redactMemoryEvents = realRedact;
    await replayLedgerEvents({ store, storage, scope, logger: silent });
    expect(store.queryMemoryEvents({ record_id: "m_x" })[0]!.content).toBe("");
    expect(getLedgerHealth(store, scope)).toMatchObject({ degraded: false, pending_redactions: 0 });
  });
});

describe("canonIsoTs strictness", () => {
  it("rejects out-of-range fields instead of letting Date.parse roll them over", () => {
    for (const v of [
      "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z",
      "2026-09-25T24:00:00Z", "2026-09-25T23:60:00Z", "2026-09-25T23:59:60Z", "2026-09-25T12:00:00+24:00",
    ]) expect(canonIsoTs(v), v).toBeNull();
    expect(canonIsoTs("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("rejects instants whose canonical form would leave the 4-digit year", () => {
    expect(canonIsoTs("9999-12-31T23:59:59.999-01:00")).toBeNull();
    expect(canonIsoTs("0000-01-01T00:30:00+01:00")).toBeNull();
    expect(canonIsoTs("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
  });

  it("maps legacy marker untils without widening; others stay null", () => {
    expect(canonLegacyUntil("2026-03-01T10:00:00.123999Z")).toBe("2026-03-01T10:00:00.123Z");
    expect(canonLegacyUntil("2026-03-01")).toBe("2026-02-28T23:59:59.999Z");
    expect(canonLegacyUntil("2026-02-30")).toBeNull();
    expect(canonLegacyUntil("March 5, 2026")).toBeNull();
    expect(canonLegacyUntil("2026-03-01T10:00:00")).toBeNull();
  });
});
