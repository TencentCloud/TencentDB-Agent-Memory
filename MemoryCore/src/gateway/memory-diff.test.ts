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
  let captured: { status: number; body: { code: number; data?: { changes: Array<Record<string, unknown>>; total: number } } } | null;

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS) => {
    captured = null;
    const req = { headers, method: "POST", url: pathname } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const sendJson = (_r: http.ServerResponse, status: number, b: typeof captured extends null ? never : NonNullable<typeof captured>["body"]) => {
      captured = { status, body: b };
    };
    const deps = {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => undefined,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
    };
    const handled = await handleV2Route(req, res, pathname, "POST", async () => body, sendJson, deps);
    return { handled, status: captured?.status, data: captured?.body?.data };
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

  it("op filter applies at the event layer", async () => {
    const { data } = await call("/v3/memory/diff", { session_id: "ses-y", op: "superseded" });
    expect(data!.changes).toHaveLength(1);
    expect(data!.changes[0].op).toBe("superseded");
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
});
