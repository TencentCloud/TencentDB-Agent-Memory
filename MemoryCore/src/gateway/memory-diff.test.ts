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
import { StorageAdapter } from "../core/storage/adapter.js";
import { createLocalStorageBackend } from "../core/storage/factory.js";
import { appendLedgerEvent, redactLedgerEvents, replayLedgerEvents } from "../core/record/event-ledger.js";

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
    const req = { headers, method: "POST", url: pathname } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as NonNullable<typeof captured>["body"] };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({
        // 真实 appendFile 写原始字节不加换行——mock 自动补 "\n" 会掩盖
        // 调用方漏写换行的 bug（JSONL 行粘连）。
        appendFile: async (key: string, content: string) => {
          writtenFiles.set(key, (writtenFiles.get(key) ?? "") + content);
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

  it("rejects unparseable since/until instead of silently mis-filtering", async () => {
    const bad = await call("/v3/memory/diff", { session_id: "ses-y", since: "not-a-date" });
    expect(bad.status).toBe(400);
    const bad2 = await call("/v3/memory/diff", { session_id: "ses-y", until: "next friday" });
    expect(bad2.status).toBe(400);
  });

  it("equivalent bounds normalize to the same instant (…ssZ ≡ …ss.sssZ)", async () => {
    store.appendMemoryEvent({
      event_ts: "2026-09-25T12:00:00.250Z", session_key: "sk-y", session_id: "ses-y",
      team_id: "t1", user_id: "u1", agent_id: "a1",
      op: "created", record_id: "m_ms", content: "boundary",
    });
    // '…00Z' and '…00.000Z' denote the same instant — the .250Z event must
    // be included either way (pre-contract it was skipped under '…00Z').
    for (const since of ["2026-09-25T12:00:00Z", "2026-09-25T12:00:00.000Z"]) {
      const { status, data } = await call("/v3/memory/diff", { session_id: "ses-y", since });
      expect(status).toBe(200);
      expect(data!.changes.some((c) => c.record_id === "m_ms")).toBe(true);
    }
    // until at the same instant excludes the .250Z event either way.
    const excl = await call("/v3/memory/diff", { session_id: "ses-y", until: "2026-09-25T12:00:00Z" });
    expect(excl.data!.changes.some((c) => c.record_id === "m_ms")).toBe(false);
  });

  it("accepts offset/short-fraction bounds (normalized), rejects ambiguous/lossy forms", async () => {
    const off = await call("/v3/memory/diff", { session_id: "ses-y", since: "2026-09-25T20:00:00+08:00" });
    expect(off.status).toBe(200);
    const frac = await call("/v3/memory/diff", { session_id: "ses-y", since: "2026-09-25T12:00:00.5Z" });
    expect(frac.status).toBe(200);
    const noSec = await call("/v3/memory/diff", { session_id: "ses-y", since: "2026-09-25T12:00Z" });
    expect(noSec.status).toBe(200);
    for (const [key, v] of [
      ["since", "2026-09-25"],                  // date-only: until-then-excludes-the-day trap
      ["until", "2026-09-25T12:00:00"],         // zone-less: parsed as local time, compared as written
      ["since", "2026-09-25 12:00:00Z"],        // space separator
      ["until", "2026-09-25T12:00:00.123456Z"], // >ms precision: rounding would widen the bound
      ["since", "March 5, 2026"],
    ] as const) {
      const { status } = await call("/v3/memory/diff", { session_id: "ses-y", [key]: v });
      expect(status).toBe(400);
    }
  });
});

describe("POST /memory/diff/revert", () => {
  let dir: string;
  let store: VectorStore;
  const writtenFiles = new Map<string, string>();
  let failTombstone = false;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    // Local capture, not a shared `captured` — concurrent calls (the revert
    // race test) must not read each other's response. Held in an object
    // property so TS control-flow doesn't narrow the closure write away.
    const cap: { res?: { status: number; body: { code: number; data?: Record<string, unknown>; message?: string } } } = {};
    const req = { headers, method: "POST", url: pathname } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      cap.res = { status, body: b as { code: number; data?: Record<string, unknown>; message?: string } };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({
        appendFile: async (key: string, content: string) => {
          if (failTombstone && content.includes('"tombstone":"l1"')) throw new Error("cos down");
          writtenFiles.set(key, (writtenFiles.get(key) ?? "") + content);
        },
      }) as never,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    return { status: cap.res?.status, data: cap.res?.body?.data };
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

  it("a failed JSONL tombstone is reported (single and batch) instead of a clean success", async () => {
    failTombstone = true;
    try {
      const single = await call("/v3/memory/diff/revert", { record_id: "m_b" });
      expect(single.status).toBe(200);
      expect(single.data).toMatchObject({ reverted: true, tombstone_pending: true });
      await writeMemory({ ...writeIso, sessionId: "ses-z", baseDir: dir, vectorStore: store, memory: memory("salary 7000"), decision: decision("m_c", "store") });
      const batch = await call("/v3/memory/diff/revert", { record_ids: ["m_c"] });
      expect((batch.data!.results as Array<Record<string, unknown>>)[0]).toMatchObject({ reverted: true, tombstone_pending: true });
    } finally {
      failTombstone = false;
    }
  });

  it("tombstone line is newline-terminated so the next append cannot glue onto it", async () => {
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    const file = [...writtenFiles.values()].find((v) => v.includes('"tombstone":"l1"'));
    expect(file?.endsWith("\n")).toBe(true);
    // 行级完整性：文件里每个非空行都必须能独立 JSON.parse（粘连行会挂）。
    for (const line of (file ?? "").split("\n").filter((l) => l.trim())) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("blocks reverting a mid-chain record that was itself superseded", async () => {
    // m_c supersedes m_b — reverting m_b would resurrect m_a while m_c stays live.
    await writeMemory({ ...writeIso, sessionId: "ses-z", baseDir: dir, vectorStore: store, memory: memory("salary 7000"), decision: decision("m_c", "update", ["m_b"], "salary 7000") });
    const mid = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(mid.status).toBe(409);
    // Reverting the newest record in the chain is the correct path.
    const tip = await call("/v3/memory/diff/revert", { record_id: "m_c" });
    expect(tip.status).toBe(200);
    expect(tip.data).toMatchObject({ record_id: "m_c", reverted: true, restored: ["m_b"] });
  });

  it("a predecessor without a restorable snapshot blocks the revert unless force is passed", async () => {
    store.redactMemoryEvents({ team_id: "t1", agent_id: "a1", until: new Date().toISOString() });
    const blocked = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(blocked.status).toBe(409);
    expect((await store.queryL1Records({ recordIds: ["m_b"] })).map((r) => r.record_id)).toEqual(["m_b"]);

    const forced = await call("/v3/memory/diff/revert", { record_id: "m_b", force: true });
    expect(forced.status).toBe(200);
    expect(forced.data).toMatchObject({ record_id: "m_b", reverted: true, restored: [], missing: ["m_a"] });
  });

  it("a manual edit after extraction blocks the revert unless force is passed", async () => {
    // 模拟管理面镜像事件落在提取写入之后：它无 supersedes/快照/session，
    // 若被当作 lastWrite，revert 会恢复 0 条且 reverted 事件挂空 session。
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "t1", user_id: "u1", agent_id: "a1",
      op: "updated", record_id: "m_b", content: "", version: 0,
      layer: "l1", source: "api_mutation",
    });
    const blocked = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(blocked.status).toBe(409);
    const { status, data } = await call("/v3/memory/diff/revert", { record_id: "m_b", force: true });
    expect(status).toBe(200);
    expect(data).toMatchObject({ record_id: "m_b", reverted: true, restored: ["m_a"] });
    const reverted = store.queryMemoryEvents({ record_id: "m_b", op: "reverted" });
    expect(reverted[0].session_id).toBe("ses-y");
  });

  it("single-element record_ids returns the batch shape (field-driven, not length-driven)", async () => {
    const { status, data } = await call("/v3/memory/diff/revert", { record_ids: ["m_b"] });
    expect(status).toBe(200);
    expect(data).toMatchObject({ succeeded: 1, failed: 0 });
    expect(data!.results as unknown[]).toHaveLength(1);
  });

  it("record_id + record_ids combined may not exceed 50", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `m_x${i}`);
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_b", record_ids: ids });
    expect(status).toBe(400);
  });

  it("failed restore is retryable — delete of an already-deleted record must not deadlock", async () => {
    // 第一次 revert：restore 阶段 upsertL1 全部失败 → 500 且不落 reverted 标记。
    const real = store;
    store = new Proxy(real, {
      get(t, p) {
        if (p === "upsertL1") return async () => false;
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as VectorStore;
    const first = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    store = real;
    expect(first.status).toBe(500);
    // 重试：m_b 行已不在（上次已删）→ 跳过 delete 直接恢复 → 200。
    // 若 deleteL1 的 false 被当成故障，这里会永久 500。
    const retry = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ record_id: "m_b", reverted: true, restored: ["m_a"] });
  });

  it("clear of the agent after the write blocks the revert (no resurrection of cleared data)", async () => {
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "t1", agent_id: "a1", op: "deleted", record_id: "asset-1", content: "",
      version: 0, layer: "l1", source: "api_mutation", scope: "agent", until: new Date().toISOString(),
    });
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(status).toBe(409);
    expect((await store.queryL1Records({ recordIds: ["m_a"] }))).toHaveLength(0);
  });

  it("a record removed by TTL (row gone) cannot be reverted", async () => {
    await store.deleteL1("m_b");
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(status).toBe(409);
    expect((await store.queryL1Records({ recordIds: ["m_a"] }))).toHaveLength(0);
  });

  it("forked lineage: restoring m_a is refused while a concurrent successor m_c is live", async () => {
    // Two sessions both superseded m_a (m_b from beforeEach, m_c here via a synthetic event).
    await writeMemory({ ...writeIso, sessionId: "ses-z", baseDir: dir, vectorStore: store, memory: memory("salary 8000"), decision: decision("m_c", "store") });
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "sk-x", session_id: "ses-z",
      team_id: "t1", user_id: "u1", agent_id: "a1",
      op: "superseded", record_id: "m_a", content: "salary 5000", version: 0,
      superseded_by: "m_c", snapshot_json: "",
    });
    const { status, data } = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(status).toBe(409);
    expect(data).toBeUndefined();
    expect((await store.queryL1Records({ recordIds: ["m_a"] }))).toHaveLength(0);
  });

  it("store query failure fails closed with 503 and changes nothing", async () => {
    const real = store;
    store = new Proxy(real, {
      get(t, p) {
        if (p === "queryL1Records") return async () => { throw new Error("vdb down"); };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as VectorStore;
    const r = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    store = real;
    expect(r.status).toBe(503);
    expect(store.queryMemoryEvents({ record_id: "m_b", op: "reverted" })).toHaveLength(0);
  });

  it("management update carries a pre-edit snapshot and can be reverted layer by layer", async () => {
    const up = await call("/v3/atomic/update", { id: "m_b", content: "salary 6500 (manual)" });
    expect(up.status).toBe(200);
    const manual = store.queryMemoryEvents({ record_id: "m_b", source: "api_mutation", op: "updated" });
    expect(manual).toHaveLength(1);
    expect(JSON.parse(manual[0].snapshot_json!).content).toBe("salary 6000");
    expect(manual[0].content).toBe("salary 6500 (manual)");

    expect((await call("/v3/memory/diff/revert", { record_id: "m_b" })).status).toBe(409);
    const undoEdit = await call("/v3/memory/diff/revert", { record_id: "m_b", event_id: manual[0].event_id });
    expect(undoEdit.status).toBe(200);
    expect((await store.queryL1Records({ recordIds: ["m_b"] }))[0].content).toBe("salary 6000");

    const undoExtraction = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(undoExtraction.status).toBe(200);
    expect((await store.queryL1Records({ recordIds: ["m_a", "m_b"] })).map((r) => r.record_id)).toEqual(["m_a"]);
  });

  it("a manual edit made without the team header still blocks the owner's extraction revert", async () => {
    const { "x-tdai-team-id": _team, ...noTeam } = ISO_HEADERS;
    expect((await call("/v2/atomic/update", { id: "m_b", content: "salary 6500 (manual)" }, noTeam)).status).toBe(200);
    const manual = store.queryMemoryEvents({ record_id: "m_b", source: "api_mutation" });
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ team_id: "t1", user_id: "u1", agent_id: "a1" });
    expect((await call("/v3/memory/diff/revert", { record_id: "m_b" })).status).toBe(409);
    expect((await store.queryL1Records({ recordIds: ["m_b"] }))[0].content).toBe("salary 6500 (manual)");
  });

  it("reviewer identity comes from the x-tdai-reviewer-id header, never the body", async () => {
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_b", reviewer_id: "forged" }, { ...ISO_HEADERS, "x-tdai-reviewer-id": "panel-op" });
    expect(status).toBe(200);
    expect(store.queryMemoryEvents({ record_id: "m_b", op: "reverted" })[0].reviewer_id).toBe("panel-op");
  });

  it("a pending reverted marker blocks a second revert until backfill", async () => {
    const realAppend = store.appendMemoryEvent.bind(store);
    store.appendMemoryEvent = () => { throw new Error("disk full"); };
    const first = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    store.appendMemoryEvent = realAppend;
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ ledger_pending: true });
    const second = await call("/v3/memory/diff/revert", { record_id: "m_b" });
    expect(second.status).toBe(503);
  });

  it("mid-chain guard walks by row existence — a dead chain tail does not block", async () => {
    // 先 revert m_b：m_a 复活（m_b 行已删）。再补一条指向幽灵 id 的 superseded
    // 事件（无行、无事件）——链尾视为已死亡，事件丢失不能造成永久死锁。
    await call("/v3/memory/diff/revert", { record_id: "m_b" });
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "sk-x", session_id: "ses-x",
      team_id: "t1", user_id: "u1", agent_id: "a1",
      op: "superseded", record_id: "m_a", content: "old", version: 0,
      superseded_by: "m_ghost", snapshot_json: "",
    });
    const { status } = await call("/v3/memory/diff/revert", { record_id: "m_a" });
    expect(status).toBe(200);
  });

  it("two concurrent reverts of the same record serialize — exactly one wins", async () => {
    // Revert is plan-then-act; without the per-record lock both callers can
    // pass the guards and interleave restore/delete/event-append.
    const [a, b] = await Promise.all([
      call("/v3/memory/diff/revert", { record_id: "m_b" }),
      call("/v3/memory/diff/revert", { record_id: "m_b" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // Exactly one reverted event, exactly one restore — no double-acted plan.
    expect(store.queryMemoryEvents({ record_id: "m_b", op: "reverted" })).toHaveLength(1);
    expect((await store.queryL1Records({ recordIds: ["m_a", "m_b"] })).map((r) => r.record_id)).toEqual(["m_a"]);
  });
});

describe("POST /memory/history", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown> } } | null;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as unknown as http.IncomingMessage;
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

  it("strips snapshot_json from the response (full row dumps stay server-side)", async () => {
    const { data } = await call("/v3/memory/history", { record_id: "m_a" });
    const events = data!.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.snapshot_json).toBeUndefined();
  });
});

describe("POST /memory/review/inbox", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown> } } | null;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as unknown as http.IncomingMessage;
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

  it("scans the NEWEST events when the window exceeds limit (desc order)", async () => {
    // 总事件数(4) > limit(3)：升序扫描会把最新 session 切掉，倒序保证最新窗口。
    for (let i = 0; i < 2; i++) {
      await writeMemory({ ...writeIso, sessionId: `ses-new-${i}`, baseDir: dir, vectorStore: store, memory: memory(`fact ${i}`), decision: decision(`m_n${i}`, "store") });
    }
    const { status, data } = await call("/v3/memory/review/inbox", { limit: 3 });
    expect(status).toBe(200);
    expect(data!.truncated).toBe(true);
    const sids = (data!.sessions as Array<Record<string, unknown>>).map((s) => s.session_id);
    // 最新的 ses-new-1 必须在窗口内；最早的 ses-x 事件被截断属于预期。
    expect(sids).toContain("ses-new-1");
  });

  it("surfaces userless management-plane ops (clear/archive) in the (unknown) bucket", async () => {
    // clear/archive 事件无 user_id（内核数据面不解析调用者身份）——主查询按
    // 三元组过滤永远匹配不上；补充查询按 team+agent+api_mutation 捞回，
    // 且不得把**带 user_id 的他人 mutation 镜像**泄露进来。
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "t1", agent_id: "a1",
      op: "deleted", record_id: "chat_memory-t1-a1", content: "",
      layer: "l1", source: "api_mutation",
    });
    // 另一个 user 的 mutation 镜像：带 user_id，补充查询必须排除它。
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "t1", user_id: "u-other", agent_id: "a1",
      op: "deleted", record_id: "m_of_other_user", content: "",
      layer: "l1", source: "api_mutation",
    });
    const { status, data } = await call("/v3/memory/review/inbox", {});
    expect(status).toBe(200);
    const sessions = data!.sessions as Array<Record<string, unknown>>;
    const adminBucket = sessions.find((s) => s.session_id === "");
    expect(adminBucket).toBeDefined();
    expect((adminBucket!.by_op as Record<string, number>).deleted).toBe(1); // 无 user 归属的那条
    // 其他 user 的镜像不出现
    expect(JSON.stringify(sessions)).not.toContain("m_of_other_user");
  });

  it("management ops stored with user 'default' surface once — main+admin double-hit deduped", async () => {
    // 4-id 契约：无 user 归属的管理面事件落 user_id="default"。请求不带
    // user 头时 iso.userId 同样解析为 "default"——同一事件同时命中主查询
    // 与补充查询，event_id 去重后只能计一次。
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "t1", agent_id: "a1", user_id: "default",
      op: "deleted", record_id: "chat_memory-t1-a1", content: "", scope: "agent",
      layer: "l1", source: "api_mutation",
    });
    const noUser = {
      authorization: "Bearer test-key", "x-tdai-service-id": "svc",
      "x-tdai-team-id": "t1", "x-tdai-agent-id": "a1",
      "x-tdai-user-id": "default",
    };
    const { status, data } = await call("/v3/memory/review/inbox", {}, noUser);
    expect(status).toBe(200);
    const sessions = data!.sessions as Array<Record<string, unknown>>;
    const adminBucket = sessions.find((s) => s.session_id === "");
    expect((adminBucket!.by_op as Record<string, number>).deleted).toBe(1); // 不是 2
  });

  it("a default-user record-level mutation stays out of other users' inboxes", async () => {
    // 不带 user 头的记录级编辑同样落 user_id="default"；只有 scope="agent" 的
    // 管理面操作才进补充查询，否则会泄露进同 team/agent 下每个 user 的 inbox。
    for (const op of ["updated", "deleted"] as const) {
      store.appendMemoryEvent({
        event_ts: new Date().toISOString(), session_key: "", session_id: "",
        team_id: "t1", agent_id: "a1", user_id: "default",
        op, record_id: `m_default_${op}`, content: "", layer: "l1", source: "api_mutation",
      });
    }
    const { status, data } = await call("/v3/memory/review/inbox", {});
    expect(status).toBe(200);
    const sessions = data!.sessions as Array<Record<string, unknown>>;
    expect(sessions.find((x) => x.session_id === "")).toBeUndefined();
  });

  it("retention (TTL) events stay out of a real tenant's review inbox", async () => {
    // retention 事件没有租户身份——落到 "default" 桶，只对 default 范围的
    // 审阅可见；真实租户（t1/a1/u1）的 inbox 不含它（不跨租户泄漏）。
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "default", agent_id: "default", user_id: "default",
      op: "deleted", record_id: "retention-l1-2026-03-01", content: "",
      layer: "l1", source: "retention",
    });
    const { status, data } = await call("/v3/memory/review/inbox", {});
    expect(status).toBe(200);
    expect((data!.sessions as Array<Record<string, unknown>>).find((x) => x.session_id === "")).toBeUndefined();
  });

  it("retention events stay out of the default tenant's inbox too", async () => {
    store.appendMemoryEvent({
      event_ts: new Date().toISOString(), session_key: "", session_id: "",
      team_id: "default", agent_id: "default", user_id: "default",
      op: "deleted", record_id: "retention-l1-2026-03-01", content: "",
      layer: "l1", source: "retention", scope: "retention",
    });
    const defaults = {
      authorization: "Bearer test-key", "x-tdai-service-id": "svc",
      "x-tdai-team-id": "default", "x-tdai-agent-id": "default", "x-tdai-user-id": "default",
    };
    const { status, data } = await call("/v3/memory/review/inbox", {}, defaults);
    expect(status).toBe(200);
    // inbox 只输出 session 聚合（不含 record_id）——断言无 retention 形成的空 session 桶。
    expect((data!.sessions as Array<Record<string, unknown>>).find((x) => x.session_id === "")).toBeUndefined();
  });
});

describe("mutation → memory_events mirror (unified change ledger)", () => {
  let dir: string;
  let store: VectorStore;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown> } } | null;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as { code: number; data?: Record<string, unknown> } };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as ({ status: number; body: { code: number; data?: Record<string, unknown> } } | null);
    return { status: cap?.status, data: cap?.body?.data };
  };

  const writeIso = { sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1" };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-mirror-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    await writeMemory({ ...writeIso, baseDir: dir, vectorStore: store, memory: memory("salary 5000"), decision: decision("m_a", "store") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomic/delete writes both an audit row and a memory_events mirror", async () => {
    const { status } = await call("/v3/atomic/delete", { ids: ["m_a"] });
    expect(status).toBe(200);

    // audit row (API access log, preserved as-is)
    const audits = store.queryAudit!({ record_id: "m_a" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ layer: "L1", action: "delete", version: 0 });

    // events mirror (unified change ledger, source=api_mutation)
    const events = store.queryMemoryEvents({ record_id: "m_a", op: "deleted" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "deleted", layer: "l1", source: "api_mutation", version: 0,
      team_id: "t1", user_id: "u1", agent_id: "a1",
    });
    expect(events[0].session_id).toBe(""); // management-plane mutation has no session
  });

  it("source/layer filters scope the mirror query", async () => {
    await call("/v3/atomic/delete", { ids: ["m_a"] });
    const apiOnly = store.queryMemoryEvents({ source: "api_mutation" });
    expect(apiOnly).toHaveLength(1);
    const extractionOnly = store.queryMemoryEvents({ source: "extraction" });
    expect(extractionOnly.map((e) => e.op)).toEqual(["created"]);
    const l2Only = store.queryMemoryEvents({ layer: "l2" });
    expect(l2Only).toHaveLength(0);
  });

  it("atomic/update returning false → 503 and no phantom updated event", async () => {
    const realUpsert = store.upsertL1.bind(store);
    store.upsertL1 = () => false; // degraded backend rejects the write
    const { status } = await call("/v3/atomic/update", { id: "m_a", content: "hacked" });
    expect(status).toBe(503);
    // The ledger must not record a change that never landed.
    expect(store.queryMemoryEvents({ record_id: "m_a", op: "updated" })).toHaveLength(0);
    expect(store.queryMemoryEvents({ record_id: "m_a", source: "api_mutation" })).toHaveLength(0);
    store.upsertL1 = realUpsert;
    const ok = await call("/v3/atomic/update", { id: "m_a", content: "fixed" });
    expect(ok.status).toBe(200);
    expect(store.queryMemoryEvents({ record_id: "m_a", op: "updated" })).toHaveLength(1);
  });

  it("atomic/update refuses to write a record owned by another tenant", async () => {
    // m_a belongs to t1 — a caller asserting t2 must not reach the write.
    const { status } = await call("/v3/atomic/update", { id: "m_a", content: "hijack" }, {
      ...ISO_HEADERS, "x-tdai-team-id": "t2",
    });
    expect(status).toBe(403);
    const row = (await store.queryL1Records({ recordIds: ["m_a"] }))[0]!;
    expect(row.content).not.toBe("hijack");
    expect(store.queryMemoryEvents({ record_id: "m_a", op: "updated" })).toHaveLength(0);
  });
});

const SINCE = "2000-01-01T00:00:00.000Z";

describe("change-ledger outbox endpoints", () => {
  let dir: string;
  let store: VectorStore;
  let storage: StorageAdapter;
  let backfillEnabled = true;
  let captured: { status: number; body: { code: number; data?: Record<string, unknown> } } | null;

  const call = async (pathname: string, body: unknown) => {
    captured = null;
    const req = { headers: ISO_HEADERS, method: "POST", url: pathname } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: unknown) => {
      captured = { status, body: b as NonNullable<typeof captured>["body"] };
    };
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => storage,
      ledgerBackfillEnabled: backfillEnabled,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as ({ status: number; body: { code: number; data?: Record<string, unknown> } } | null);
    return { status: cap?.status, data: cap?.body?.data };
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-ledger-"));
    backfillEnabled = true;
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    storage = new StorageAdapter(createLocalStorageBackend(path.join(dir, "data")));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("management mutations land in the outbox with the same event_id as the store row", async () => {
    await writeMemory({ sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1", baseDir: dir, vectorStore: store, storage, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    await call("/v3/atomic/delete", { ids: ["m_a"] });
    const names = await storage.readdirNames("events/", ".jsonl");
    const lines = (await Promise.all(names.map((n) => storage.readFile(`events/${n}`))))
      .join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event_id: string; op: string });
    expect(lines.map((l) => l.op).sort()).toEqual(["created", "deleted"]);
    const storeIds = store.queryMemoryEvents({ record_id: "m_a" }).map((e) => e.event_id).sort();
    expect(lines.map((l) => l.event_id).sort()).toEqual(storeIds);
  });

  it("backfill replays outbox events the store never received, idempotently", async () => {
    const failing = { appendMemoryEvent: () => { throw new Error("vdb down"); } } as unknown as Parameters<typeof appendLedgerEvent>[0]["store"];
    await appendLedgerEvent({ store: failing, storage, event: {
      event_ts: new Date().toISOString(), session_key: "sk-x", session_id: "ses-x",
      team_id: "t1", agent_id: "a1", user_id: "u1", op: "created", record_id: "m_lost", content: "lost", source: "extraction",
    } });
    await appendLedgerEvent({ store: failing, storage, event: {
      event_ts: new Date().toISOString(), session_key: "sk-z", session_id: "ses-z",
      team_id: "t2", agent_id: "a1", op: "created", record_id: "m_foreign", content: "other tenant",
    } });
    expect((await call("/v3/memory/diff", { session_id: "ses-x" })).data!.changes).toEqual([]);

    const first = await call("/v3/memory/ledger/backfill", { since: SINCE });
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ replayed: 1, skipped: 1, failed: 0 });
    await call("/v3/memory/ledger/backfill", { since: SINCE });

    const diff = await call("/v3/memory/diff", { session_id: "ses-x" });
    expect((diff.data!.changes as Array<{ record_id: string }>).map((c) => c.record_id)).toEqual(["m_lost"]);
    expect(store.queryMemoryEvents({ record_id: "m_foreign" })).toHaveLength(0);
  });

  it("backfill is off unless enabled, and requires since", async () => {
    backfillEnabled = false;
    expect((await call("/v3/memory/ledger/backfill", { since: SINCE })).status).toBe(403);
    backfillEnabled = true;
    expect((await call("/v3/memory/ledger/backfill", {})).status).toBe(400);
  });

  it("ledger health is per tenant and never leaks raw backend errors", async () => {
    const realAppend = store.appendMemoryEvent.bind(store);
    store.appendMemoryEvent = () => { throw new Error("secret-dsn://user:pw@host"); };
    await appendLedgerEvent({ store, storage, event: {
      event_ts: new Date().toISOString(), session_key: "sk-z", session_id: "ses-z",
      team_id: "t2", agent_id: "a1", op: "created", record_id: "m_t2", content: "t2",
    } });
    store.appendMemoryEvent = realAppend;
    const mine = await call("/v3/memory/ledger/status", {});
    expect(mine.data).toMatchObject({ health: { degraded: false, pending_store_events: 0, store_failures: 0 } });
    expect(JSON.stringify(mine.data)).not.toContain("secret-dsn");
  });

  it("clear redacts content/snapshots in store and outbox; backfill does not restore it", async () => {
    await writeMemory({ sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1", baseDir: dir, vectorStore: store, storage, memory: memory("salary 5000"), decision: decision("m_a", "store") });
    const until = new Date(Date.now() + 1).toISOString();
    await redactLedgerEvents({ store, storage, filter: { team_id: "t1", agent_id: "a1", until } });
    expect(store.queryMemoryEvents({ record_id: "m_a" })[0].content).toBe("");
    const names = await storage.readdirNames("events/", ".jsonl");
    const raw = (await Promise.all(names.map((n) => storage.readFile(`events/${n}`)))).join("");
    expect(raw).not.toContain("salary 5000");
    const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { redact?: unknown; op?: string; record_id?: string; content?: string });
    expect(rows.filter((r) => r.redact)).toEqual([expect.objectContaining({ redact: { team_id: "t1", agent_id: "a1", until } })]);
    expect(rows.find((r) => r.record_id === "m_a")).toMatchObject({ op: "created", content: "" });
    // rebuild a fresh store from the outbox: cleared content must stay cleared
    const fresh = new VectorStore(path.join(dir, "fresh.db"), 0);
    fresh.init();
    const r = await replayLedgerEvents({ store: fresh, storage, since: SINCE });
    expect(r.redacted).toBe(1);
    const ev = fresh.queryMemoryEvents({ record_id: "m_a" });
    expect(ev).toHaveLength(1);
    expect(ev[0].content).toBe("");
    expect(ev[0].op).toBe("created");
    fresh.close();
  });

  it("status reports outbox availability, and diff/inbox flag a degraded ledger", async () => {
    const ok = await call("/v3/memory/ledger/status", {});
    expect(ok.data).toMatchObject({ supported: true, jsonl_outbox: true, health: { degraded: false } });
    expect((await call("/v3/memory/diff", { session_id: "ses-x" })).data!.ledger).toBeUndefined();

    const realAppend = store.appendMemoryEvent.bind(store);
    store.appendMemoryEvent = () => { throw new Error("disk full"); };
    await writeMemory({ sessionKey: "sk-x", sessionId: "ses-x", teamId: "t1", userId: "u1", agentId: "a1", baseDir: dir, vectorStore: store, storage, memory: memory("salary 7000"), decision: decision("m_c", "store") });
    store.appendMemoryEvent = realAppend;

    const status = await call("/v3/memory/ledger/status", {});
    expect(status.data).toMatchObject({ health: { degraded: true, store_failures: 1 } });
    expect((await call("/v3/memory/diff", { session_id: "ses-x" })).data!.ledger).toMatchObject({ degraded: true, store_failures: 1 });
    expect((await call("/v3/memory/review/inbox", {})).data!.ledger).toMatchObject({ degraded: true });
    expect(status.data).toMatchObject({ health: { pending_store_events: 1 } });

    await call("/v3/memory/ledger/backfill", { since: SINCE });
    const healed = await call("/v3/memory/ledger/status", {});
    expect(healed.data).toMatchObject({ health: { degraded: false, pending_store_events: 0, store_failures: 1 } });
    expect((await call("/v3/memory/diff", { session_id: "ses-x" })).data!.ledger).toBeUndefined();
  });
});

describe("conversation/add idempotency", () => {
  let dir: string;
  let store: VectorStore;
  let notified = 0;

  const call = async (body: unknown, headers: Record<string, string> = {}) => {
    let captured: { status: number; body: { data?: { accepted_ids: string[] } } } | null = null;
    const req = { headers: { ...ISO_HEADERS, ...headers }, method: "POST", url: "/v3/conversation/add" } as unknown as http.IncomingMessage;
    const deps = {
      deployMode: "service",
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      notifyPipeline: async () => { notified++; },
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    } as unknown as Parameters<typeof handleV2Route>[6];
    await handleV2Route(req, {} as http.ServerResponse, "/v3/conversation/add", "POST", async <T>() => body as T,
      (_r, status, b) => { captured = { status, body: b as NonNullable<typeof captured>["body"] }; }, deps);
    const cap = captured as ({ status: number; body: { data?: { accepted_ids: string[] } } } | null);
    return cap?.body?.data?.accepted_ids ?? [];
  };
  const msgs = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
  const countL0 = () => store.queryL0ForL1("ses-x").length;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conv-idem-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    notified = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("same Idempotency-Key header replays the first result without side effects", async () => {
    const key = `k-${Math.random()}`;
    const a = await call({ session_id: "ses-x", messages: msgs }, { "idempotency-key": key });
    const b = await call({ session_id: "ses-x", messages: msgs }, { "idempotency-key": key });
    expect(a).toHaveLength(2);
    expect(b).toEqual(a);
    expect(notified).toBe(1);
    expect(countL0()).toBe(2);
  });

  it("a rejected write is not cached — a retry with the same key lands the rows", async () => {
    const key = `k-${Math.random()}`;
    const real = store.upsertL0.bind(store);
    store.upsertL0 = () => false;
    await call({ session_id: "ses-x", messages: msgs }, { "idempotency-key": key });
    expect(countL0()).toBe(0);
    store.upsertL0 = real;
    const b = await call({ session_id: "ses-x", messages: msgs }, { "idempotency-key": key });
    expect(b).toHaveLength(2);
    expect(countL0()).toBe(2);
  });

  it("body idempotency_key derives deterministic ids; no key keeps random ids", async () => {
    const key = `k-${Math.random()}`;
    const a = await call({ session_id: "ses-x", messages: msgs, idempotency_key: key });
    expect(a.every((id) => /^msg-[0-9a-f]{32}$/.test(id))).toBe(true);
    const c = await call({ session_id: "ses-x", messages: msgs });
    const d = await call({ session_id: "ses-x", messages: msgs });
    expect(c[0] === d[0]).toBe(false);
    expect(countL0()).toBe(6);
  });
});
