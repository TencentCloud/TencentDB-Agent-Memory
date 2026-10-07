/**
 * POST /v3/memory/review/{retract,restore} — 事后审核撤回/恢复端点测试（N03）。
 *
 * 这组测试要证明的不是"接口返回 200"，而是**撤回之后记忆真的进不了 prompt**，
 * 以及一系列会让机制在生产上失效的边界：
 *  - DP-23 开关关着时写接口必须 403（否则会积累一批"以为撤掉了、其实还在喂"的记录）
 *  - DP-09 作用域必须显式，不得沿用"未设置=全租户"
 *  - DP-18 幂等：重复撤回不写第二条账本事件
 *  - DP-19 reviewer_id 只取服务端身份
 *  - DP-01 retract 不删行、不断血缘：/memory/history 仍能查到这条记忆的全生命周期
 *  - 跨租户返回 not_found，不泄漏他人 record 是否存在
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../core/store/sqlite/memory-store.js";
import { __setMemoryReviewEnabledForTests } from "../core/store/visibility.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import { handleV2Route, type V2RouterDeps } from "./v2-router.js";
import { StorageAdapter, scopeProfileStorageView } from "../core/storage/adapter.js";
import { createLocalStorageBackend } from "../core/storage/factory.js";

function rec(over: Partial<MemoryRecord> & { id: string; content: string }): MemoryRecord {
  return {
    type: "work_fact", priority: 50, scene_name: "default",
    source_message_ids: [], metadata: {}, timestamps: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1, sessionKey: "sk-a", sessionId: "ses-a",
    teamId: "t1", userId: "u1", agentId: "a1",
    ...over,
  } as MemoryRecord;
}

const ISO_HEADERS = {
  authorization: "Bearer test-key",
  "x-tdai-service-id": "svc",
  "x-tdai-team-id": "t1",
  "x-tdai-agent-id": "a1",
  "x-tdai-user-id": "u1",
};

describe("POST /memory/review/retract|restore", () => {
  let dir: string;
  let store: VectorStore;
  const writtenFiles = new Map<string, string>();

  const call = async (pathname: string, body: unknown, headers: Record<string, string> = ISO_HEADERS, overrides: Partial<V2RouterDeps> = {}) => {
    let captured: { status: number; body: { code: number; message?: string; data?: Record<string, unknown> } } | null = null;
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
        appendFile: async (key: string, content: string) => {
          writtenFiles.set(key, (writtenFiles.get(key) ?? "") + content);
        },
      }) as never,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      ...overrides,
    } as unknown as Parameters<typeof handleV2Route>[6];
    const handled = await handleV2Route(req, res, pathname, "POST", async <T>() => body as T, sendJson, deps);
    const cap = captured as { status: number; body: { code: number; message?: string; data?: Record<string, unknown> } } | null;
    return { handled, status: cap?.status, message: cap?.body?.message, data: cap?.body?.data };
  };

  beforeEach(() => {
    __setMemoryReviewEnabledForTests(true);
    writtenFiles.clear();
    dir = mkdtempSync(path.join(tmpdir(), "mem-review-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    __setMemoryReviewEnabledForTests(undefined);
    try { store.close?.(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("撤回之后记忆真的进不了读路径，restore 之后回来", async () => {
    store.upsertL1(rec({ id: "m_1", content: "用户的报销上限是 500 元" }), undefined);
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })).toHaveLength(1);

    const r = await call("/v3/memory/review/retract", { record_id: "m_1", reason: "抽取错误：把同事的额度记成了用户的" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, mode: "retract", changed: ["m_1"], no_op: [], not_found: [] });

    // 真正的验收点：默认读路径看不到了
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })).toHaveLength(0);
    // 但行还在，血缘没断（DP-01）
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1", visibility: "all" })).toHaveLength(1);

    const back = await call("/v3/memory/review/restore", { record_id: "m_1" });
    expect(back.status).toBe(200);
    expect(back.data).toMatchObject({ mode: "restore", changed: ["m_1"] });
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })).toHaveLength(1);
  });

  it("账本：撤回写 retracted 事件，带 reason 和服务端 reviewer_id（DP-19）", async () => {
    store.upsertL1(rec({ id: "m_2", content: "待撤回内容" }), undefined);
    await call("/v3/memory/review/retract", {
      record_id: "m_2",
      reason: "与事实不符",
      // 客户端试图伪造审核人——必须被忽略
      reviewer_id: "attacker",
    });
    const events = store.queryMemoryEvents!({ record_id: "m_2" }) as unknown as Array<Record<string, unknown>>;
    const retracted = events.filter((e) => e.op === "retracted");
    expect(retracted).toHaveLength(1);
    expect(retracted[0].reason).toBe("与事实不符");
    // DP-35：没传 x-tdai-reviewer-id ⇒ 不署名。绝不回落成 iso.userId ——
    // 那是记忆所有者，写进去就是一条伪造的"本人自查"记录。
    expect(retracted[0].reviewer_id ?? "").toBe("");
    expect(retracted[0].reviewer_id).not.toBe("attacker");
    expect(retracted[0].record_id).toBe("m_2");
  });

  it("rejects whitespace, oversized and control-character record identities before querying", async () => {
    for (const record_id of ["   ", "x".repeat(1025), "unsafe\nid"]) {
      const result = await call("/v3/memory/review/retract", { record_id, reason: "r" });
      expect(result.status).toBe(400);
    }
    expect(store.queryMemoryEvents({})).toEqual([]);
  });

  it("an explicit empty task scope can replay its committed receipt without becoming not_found", async () => {
    store.upsertL1(rec({ id: "task_empty", content: "fact" }), undefined);
    const body = { record_id: "task_empty", task_id: "", reason: "r", operation_id: "empty-task-operation" };
    const first = await call("/v3/memory/review/retract", body);
    const retry = await call("/v3/memory/review/retract", body);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ changed: ["task_empty"], not_found: [] });
    expect(retry.data?.event_ids).toEqual(first.data?.event_ids);
    expect(store.queryMemoryEvents({ record_id: "task_empty", op: "retracted" })).toHaveLength(1);
  });

  it("DP-18 同身份重试返回原结果，不同身份产生独立撤回", async () => {
    store.upsertL1(rec({ id: "m_3", content: "幂等" }), undefined);
    const body = { record_id: "m_3", reason: "r1", operation_id: "stable-retraction" };
    const first = await call("/v3/memory/review/retract", body);
    const again = await call("/v3/memory/review/retract", body);
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ changed: ["m_3"], no_op: [] });
    expect(again.data?.event_ids).toEqual(first.data?.event_ids);
    expect(store.queryMemoryEvents({ record_id: "m_3", op: "retracted" })).toHaveLength(1);
    const independent = await call("/v3/memory/review/retract", { ...body, operation_id: "independent-retraction" });
    expect(independent.data).toMatchObject({ changed: ["m_3"], no_op: [] });
    expect(store.queryMemoryEvents({ record_id: "m_3", op: "retracted" })).toHaveLength(2);
  });

  it("幂等空操作与查无此记录必须分开报，调用方才能分清自己撤错了 id", async () => {
    store.upsertL1(rec({ id: "m_4", content: "存在" }), undefined);
    const r = await call("/v3/memory/review/retract", { record_id: "m_4", record_ids: ["m_nope"], reason: "r" });
    expect(r.data).toMatchObject({ changed: ["m_4"], not_found: ["m_nope"] });
  });

  it("跨租户：返回 not_found 而非 403，不泄漏他人 record 是否存在", async () => {
    store.upsertL1(rec({ id: "m_5", content: "他人租户的记忆", userId: "someone-else" }), undefined);
    const r = await call("/v3/memory/review/retract", { record_id: "m_5", reason: "r" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ changed: [], not_found: ["m_5"] });
    // 对方的记忆必须仍然可见
    expect(store.queryL1Records({ teamId: "t1", userId: "someone-else", agentId: "a1" })).toHaveLength(1);
  });

  it("DP-23 开关关闭时写接口 403 —— 不允许积累“以为撤掉了、其实还在喂”的记录", async () => {
    __setMemoryReviewEnabledForTests(false);
    store.upsertL1(rec({ id: "m_6", content: "x" }), undefined);
    const r = await call("/v3/memory/review/retract", { record_id: "m_6", reason: "r" });
    expect(r.status).toBe(403);
    expect(r.message).toMatch(/TDAI_MEMORY_REVIEW_ENABLED/);
  });

  it("DP-09 缺租户作用域 → 拒绝（不得沿用“未设置=全租户”）", async () => {
    store.upsertL1(rec({ id: "m_7", content: "x" }), undefined);
    const r = await call("/v3/memory/review/retract", { record_id: "m_7", reason: "r" }, {
      authorization: "Bearer test-key", "x-tdai-service-id": "svc", "x-tdai-team-id": "t1",
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })).toHaveLength(1);
  });

  it("撤回必须带理由；批量上限 50", async () => {
    store.upsertL1(rec({ id: "m_8", content: "x" }), undefined);
    const noReason = await call("/v3/memory/review/retract", { record_id: "m_8" });
    expect(noReason.status).toBe(400);

    const tooMany = await call("/v3/memory/review/retract", {
      record_ids: Array.from({ length: 51 }, (_, i) => `m_x_${i}`), reason: "r",
    });
    expect(tooMany.status).toBe(400);
  });

  it("批量撤回：逐条结算，部分成功不回滚已成功的部分", async () => {
    store.upsertL1(rec({ id: "m_b1", content: "a" }), undefined);
    store.upsertL1(rec({ id: "m_b2", content: "b" }), undefined);
    const r = await call("/v3/memory/review/retract", {
      record_ids: ["m_b1", "m_b2", "m_missing"], reason: "批量",
    });
    expect(r.data).toMatchObject({ changed: ["m_b1", "m_b2"], not_found: ["m_missing"] });
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })).toHaveLength(0);
  });

  // ───────────── DP-30 审核清单：撤回必须是可逆的「操作」而不是单向黑洞 ─────────────

  it("DP-30 撤回后能把它列出来 —— 否则丢了 record_id 就永远 restore 不回来", async () => {
    store.upsertL1(rec({ id: "m_l1", content: "quota is five hundred" }), undefined);
    store.upsertL1(rec({ id: "m_l2", content: "healthy memory" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_l1", reason: "抽取错误" });

    // 此时 /atomic/query 已经看不到它了 —— 这正是没有本接口就无法恢复的原因
    const aq = await call("/v3/atomic/query", { limit: 50 });
    expect((aq.data?.items as Array<{ id: string }>).map((i) => i.id)).not.toContain("m_l1");

    // 默认口径就是 quarantined：审核台最常问的是"我撤了哪些"
    const list = await call("/v3/memory/review/list", {});
    expect(list.status).toBe(200);
    expect(list.data?.visibility).toBe("quarantined");
    const ids = (list.data?.items as Array<{ record_id: string }>).map((i) => i.record_id);
    expect(ids).toEqual(["m_l1"]);
    expect(ids).not.toContain("m_l2");

    // 闭环：拿列表里的 id 真的能恢复
    const back = await call("/v3/memory/review/restore", { record_id: ids[0] });
    expect(back.data).toMatchObject({ changed: ["m_l1"] });
    expect(store.queryL1Records({ teamId: "t1", userId: "u1", agentId: "a1" })).toHaveLength(2);
  });

  it("DP-30 visibility=all 必须带 review_status，否则分不清哪条被撤回", async () => {
    store.upsertL1(rec({ id: "m_s1", content: "alpha" }), undefined);
    store.upsertL1(rec({ id: "m_s2", content: "beta" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_s1", reason: "状态列测试" });

    const all = await call("/v3/memory/review/list", { visibility: "all" });
    expect(all.data?.total).toBe(2);
    const byId = Object.fromEntries(
      (all.data?.items as Array<{ record_id: string; review_status: string }>).map((i) => [i.record_id, i.review_status]),
    );
    expect(byId).toEqual({ m_s1: "quarantined", m_s2: "active" });
  });

  it("DP-32 开关关闭时清单仍可读 —— 紧急回滚之后恰恰最需要查「现在撤了哪些」", async () => {
    store.upsertL1(rec({ id: "m_off", content: "gamma" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_off", reason: "回滚审计测试" });

    __setMemoryReviewEnabledForTests(false);
    // 写操作仍然 403
    const w = await call("/v3/memory/review/retract", { record_id: "m_off", reason: "开关关闭" });
    expect(w.status).toBe(403);
    // 只读审计面放行
    const r = await call("/v3/memory/review/list", { visibility: "all" });
    expect(r.status).toBe(200);
    expect((r.data?.items as Array<{ record_id: string }>).map((i) => i.record_id)).toContain("m_off");
  });

  it("DP-09 清单同样不接受空作用域", async () => {
    const r = await call("/v3/memory/review/list", {}, {
      authorization: "Bearer test-key", "x-tdai-service-id": "svc", "x-tdai-team-id": "t1",
    } as Record<string, string>);
    expect(r.status).not.toBe(200);
  });

  it("DP-19' reviewer_id 以 x-tdai-reviewer-id 头为准，与基线 revert 口径一致；请求体仍不可伪造", async () => {
    store.upsertL1(rec({ id: "m_rv", content: "delta" }), undefined);
    await call("/v3/memory/review/retract",
      { record_id: "m_rv", reason: "审核人口径测试", reviewer_id: "attacker-in-body" },
      { ...ISO_HEADERS, "x-tdai-reviewer-id": "alice@corp" });
    const events = store.queryMemoryEvents!({ record_id: "m_rv" }) as unknown as Array<Record<string, unknown>>;
    const retracted = events.filter((e) => e.op === "retracted");
    expect(retracted).toHaveLength(1);
    expect(retracted[0].reviewer_id).toBe("alice@corp");
  });

  // ───────────── DP-35 操作者署名（上游 #1539 评审的 Core 侧根因）─────────────

  it("DP-35 无 x-tdai-reviewer-id ⇒ 不署名，且响应显式标记 unattributed", async () => {
    store.upsertL1(rec({ id: "m_na", content: "epsilon" }), undefined);
    const r = await call("/v3/memory/review/retract", { record_id: "m_na", reason: "无署名" });
    expect(r.data?.reviewer_attribution).toBe("unattributed");
    const ev = (store.queryMemoryEvents!({ record_id: "m_na" }) as unknown as Array<Record<string, unknown>>)
      .filter((e) => e.op === "retracted");
    // 关键：绝不能等于 u1（记忆所有者）—— 那是一条伪造的"本人自查"
    expect(ev[0].reviewer_id ?? "").not.toBe("u1");
    expect(ev[0].reviewer_id ?? "").toBe("");
  });

  it("DP-35 带头 ⇒ asserted，且署名的是操作者而非记忆所有者", async () => {
    store.upsertL1(rec({ id: "m_at", content: "zeta" }), undefined);
    const r = await call("/v3/memory/review/retract",
      { record_id: "m_at", reason: "有署名" },
      { ...ISO_HEADERS, "x-tdai-reviewer-id": "admin@corp" });
    expect(r.data?.reviewer_attribution).toBe("asserted");
    const ev = (store.queryMemoryEvents!({ record_id: "m_at" }) as unknown as Array<Record<string, unknown>>)
      .filter((e) => e.op === "retracted");
    expect(ev[0].reviewer_id).toBe("admin@corp");
    expect(ev[0].user_id).toBe("u1");   // 数据主体仍是 u1，两者不混
  });

  it("DP-30 清单必须显式给 has_more，不能把截断的一页呈现成全部", async () => {
    for (let i = 0; i < 3; i++) store.upsertL1(rec({ id: `m_p${i}`, content: `page ${i}` }), undefined);
    for (let i = 0; i < 3; i++) await call("/v3/memory/review/retract", { record_id: `m_p${i}`, reason: "分页" });

    const p1 = await call("/v3/memory/review/list", { limit: 2, offset: 0 });
    expect(p1.data?.total).toBe(3);
    expect(p1.data?.has_more).toBe(true);
    expect(p1.data?.next_offset).toBe(2);

    const p2 = await call("/v3/memory/review/list", { limit: 2, offset: 2 });
    expect(p2.data?.has_more).toBe(false);
    expect(p2.data?.next_offset).toBeUndefined();
  });

  it.each(["/v2", "/v3"])("%s review rejects implicit tenancy even when strict isolation is disabled", async (prefix) => {
    store.upsertL1(rec({ id: "m_default", content: "default bucket", teamId: "default", userId: "default", agentId: "default" }), undefined);
    const headers = { authorization: "Bearer test-key", "x-tdai-service-id": "svc" };
    for (const suffix of ["retract", "restore", "list"]) {
      const r = await call(`${prefix}/memory/review/${suffix}`, suffix === "list" ? {} : { record_id: "m_default", reason: "r" }, headers, { v3StrictIsolation: false });
      expect(r.status).toBe(400);
    }
    expect(store.queryL1Records({ recordIds: ["m_default"], visibility: "all" })[0]?.review_status).toBe("active");
  });

  it("review mutations honor the request task scope", async () => {
    store.upsertL1(rec({ id: "m_task", content: "other task", taskId: "task-b" }), undefined);
    const r = await call("/v3/memory/review/retract", { record_id: "m_task", reason: "r" }, { ...ISO_HEADERS, "x-tdai-task-id": "task-a" });
    expect(r.data).toMatchObject({ changed: [], not_found: ["m_task"] });
  });

  it("disabled review list still filters explicit quarantined visibility", async () => {
    store.upsertL1(rec({ id: "m_hidden", content: "hidden" }), undefined);
    store.upsertL1(rec({ id: "m_active", content: "active" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_hidden", reason: "r" });
    __setMemoryReviewEnabledForTests(false);
    const r = await call("/v3/memory/review/list", {});
    expect((r.data?.items as Array<{ record_id: string }>).map((row) => row.record_id)).toEqual(["m_hidden"]);
    expect(r.data?.total).toBe(1);
  });

  it("degraded review mutations fail loudly instead of claiming not_found", async () => {
    vi.spyOn(store, "isDegraded").mockReturnValue(true);
    const r = await call("/v3/memory/review/retract", { record_id: "m_any", reason: "r" });
    expect(r.status).toBe(503);
  });

  it("batch write failure exposes already committed results", async () => {
    store.upsertL1(rec({ id: "m_first", content: "first" }), undefined);
    const setStatus = store.setL1ReviewStatus.bind(store);
    vi.spyOn(store, "setL1ReviewStatus").mockImplementationOnce(setStatus).mockImplementationOnce(() => { throw new Error("store unavailable"); });
    const r = await call("/v3/memory/review/retract", { record_ids: ["m_first", "m_second"], reason: "r" });
    expect(r.status).toBe(503);
    expect(r.data).toMatchObject({ partial: { changed: ["m_first"], no_op: [], not_found: [] }, failed_record_id: "m_second" });
  });

  it("revert checks physical existence rather than consumer visibility", async () => {
    store.upsertL1(rec({ id: "m_revert_hidden", content: "hidden" }), undefined);
    store.appendMemoryEvent({ event_ts: "2026-01-01T00:00:00.000Z", session_key: "sk-a", session_id: "ses-a", team_id: "t1", user_id: "u1", agent_id: "a1", op: "created", record_id: "m_revert_hidden", content: "hidden", source: "extraction" });
    await call("/v3/memory/review/retract", { record_id: "m_revert_hidden", reason: "r" });
    const r = await call("/v3/memory/diff/revert", { record_id: "m_revert_hidden" });
    expect(r.status).toBe(200);
    expect(store.queryL1Records({ recordIds: ["m_revert_hidden"], visibility: "all" })).toEqual([]);
  });

  it("downstream scan failure is disclosed on receipt replay without changing committed success", async () => {
    store.upsertL1(rec({ id: "scan", content: "fact" }), undefined);
    const body = { record_id: "scan", reason: "r", operation_id: "scan-review" };
    const result = await call("/v3/memory/review/retract", body);
    expect(result.status).toBe(200);
    expect(result.data?.downstream).toMatchObject({ scan: "failed", lineage_analyzed: false });
    const repeat = await call("/v3/memory/review/retract", body, ISO_HEADERS, { getStorage: () => undefined });
    expect(repeat.data?.downstream).toMatchObject({ scan: "unavailable", artifacts: [] });
    expect(repeat.data?.event_ids).toEqual(result.data?.event_ids);
    expect(store.queryMemoryEvents({ record_id: "scan", op: "retracted" })).toHaveLength(1);
  });

  it("derived review verifies current bytes without restoring the wrong L1 fact", async () => {
    const base = new StorageAdapter(createLocalStorageBackend(path.join(dir, "data")));
    const scoped = scopeProfileStorageView(base, `profiles/${encodeURIComponent("team:t1|agent:a1")}/`, { teamId: "t1", agentId: "a1" });
    await scoped.writeFile("persona.md", "reviewed derived text");
    store.upsertL1(rec({ id: "m_derived", content: "wrong" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_derived", reason: "r" });
    const overrides = { getStorage: () => base };
    const read = await call("/v3/memory/review/derived", { path: "persona.md" }, ISO_HEADERS, overrides);
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ content: "reviewed derived text", blocked: true });
    const ack = await call("/v3/memory/review/derived", { path: "persona.md", acknowledge: true, expected_hash: read.data?.content_hash, expected_fence: read.data?.fence_hash, reason: "manually checked", operation_id: "ack" }, ISO_HEADERS, overrides);
    expect(ack.status).toBe(200);
    expect(ack.data).toMatchObject({ acknowledged: true, still_blocked: false });
    expect(store.queryMemoryEvents({ source: "review", layer: "l3" })[0]?.user_id).toBe("default");
    expect(store.queryL1Records({ recordIds: ["m_derived"], visibility: "all" })[0]?.review_status).toBe("quarantined");
    store.upsertL1(rec({ id: "later_review", content: "second wrong fact" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "later_review", reason: "new review" });
    const outdatedFence = await call("/v3/memory/review/derived", { path: "persona.md", acknowledge: true, expected_hash: read.data?.content_hash, expected_fence: read.data?.fence_hash, reason: "old confirmation" }, ISO_HEADERS, overrides);
    expect(outdatedFence.status).toBe(409);
    const reread = await call("/v3/memory/review/derived", { path: "persona.md" }, ISO_HEADERS, overrides);
    expect(reread.data?.blocked).toBe(true);
    await scoped.writeFile("persona.md", "changed text");
    const stale = await call("/v3/memory/review/derived", { path: "persona.md", acknowledge: true, expected_hash: read.data?.content_hash, expected_fence: read.data?.fence_hash, reason: "r" }, ISO_HEADERS, overrides);
    expect(stale.status).toBe(409);
    const escaped = await call("/v3/memory/review/derived", { path: "../private" }, ISO_HEADERS, overrides);
    expect(escaped.status).toBe(400);
  });

  it("operation identity is replayed, not re-executed after a later restore", async () => {
    store.upsertL1(rec({ id: "m_key", content: "keyed" }), undefined);
    const first = await call("/v3/memory/review/retract", { record_id: "m_key", reason: "r", operation_id: "first" });
    await call("/v3/memory/review/restore", { record_id: "m_key" });
    const retry = await call("/v3/memory/review/retract", { record_id: "m_key", reason: "r", operation_id: "first" });
    expect(retry.data?.event_ids).toEqual(first.data?.event_ids);
    expect(store.queryL1Records({ recordIds: ["m_key"] })).toHaveLength(1);
    const changed = await call("/v3/memory/review/retract", { record_id: "m_key", reason: "different", operation_id: "first" });
    expect(changed.status).toBe(409);
    expect(changed.message).toContain("different input");
    expect(changed.data?.commit_unknown).toBe(false);
  });

  it("historical controls remain listable and restorable without recreating rows", async () => {
    store.upsertL1(rec({ id: "m_history", content: "history" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_history", reason: "r" });
    store.deleteL1("m_history");
    const list = await call("/v3/memory/review/list", {});
    expect(list.data?.items).toEqual(expect.arrayContaining([expect.objectContaining({ record_id: "m_history", exists: false, review_status: "quarantined" })]));
    const restored = await call("/v3/memory/review/restore", { record_id: "m_history" });
    expect(restored.status).toBe(200);
    expect(store.queryL1Records({ recordIds: ["m_history"], visibility: "all" })).toEqual([]);
  });

  it("DP-01 撤回不断审计链：/memory/history 仍能查到这条记忆", async () => {
    store.upsertL1(rec({ id: "m_9", content: "审计链" }), undefined);
    await call("/v3/memory/review/retract", { record_id: "m_9", reason: "审计链测试" });
    const h = await call("/v3/memory/history", { record_id: "m_9" });
    expect(h.status).toBe(200);
    const events = (h.data?.events ?? []) as Array<Record<string, unknown>>;
    expect(events.some((e) => e.op === "retracted")).toBe(true);
  });
});
