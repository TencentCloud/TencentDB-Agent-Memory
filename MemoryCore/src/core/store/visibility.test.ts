/**
 * 事后审核可见性层（N02）。
 *
 * 这组测试的重点不是"过滤能跑"，而是**堵住两个"代码正确/测试全绿/线上不可用"的陷阱**：
 *  - DP-14 去重路径必须仍看得见被撤回的记忆，否则同一事实会以新 id 复活，
 *          审核员的撤回等于没做。
 *  - DP-04 被撤回记忆会占用召回超取窗口，不补偿就会静默降低召回，
 *          而且接口不报错、断言不失败。
 * 外加：DP-23 关闭只停新审核写，不取消既有抑制；DP-12 老数据不得凭空消失。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../record/l1-writer.js";
import { VectorStore } from "./sqlite/memory-store.js";
import { __setMemoryReviewEnabledForTests, resolveVisibilityScope, rowMatchesVisibility, withVisibilityOverFetch, recallTruncated } from "./visibility.js";

function rec(over: Partial<MemoryRecord> & { id: string; content: string }): MemoryRecord {
  return {
    type: "episodic",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    sessionKey: "sk-a",
    sessionId: "ses-a",
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
    ...over,
  } as MemoryRecord;
}

const ISO = { teamId: "t1", userId: "u1", agentId: "a1" } as const;

describe("memory review visibility", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    __setMemoryReviewEnabledForTests(true);
    dir = mkdtempSync(path.join(tmpdir(), "mem-vis-"));
    // dimensions=0 → metadata/FTS-only 模式，不需要 sqlite-vec 扩展。
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    __setMemoryReviewEnabledForTests(undefined);
    try { store.close?.(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  // ───────────────────────── 纯函数语义 ─────────────────────────

  it("缺省即抑制：没写 visibility 就只看 active（fail-safe）", () => {
    expect(rowMatchesVisibility({ review_status: "active" }, "active")).toBe(true);
    expect(rowMatchesVisibility({ review_status: "quarantined" }, "active")).toBe(false);
    expect(rowMatchesVisibility({ review_status: "quarantined" }, "all")).toBe(true);
  });

  it("legacy missing/empty status remains active, unknown nonempty status does not", () => {
    expect(rowMatchesVisibility({}, "active")).toBe(true);
    expect(rowMatchesVisibility({ review_status: null }, "active")).toBe(true);
    expect(rowMatchesVisibility({ review_status: "" }, "active")).toBe(true);
    expect(rowMatchesVisibility({ review_status: "whatever-future-value" }, "active")).toBe(false);
    // 反向：缺字段不算 quarantined
    expect(rowMatchesVisibility({}, "quarantined")).toBe(false);
  });

  it("keeps explicit audit visibility when consumer suppression is disabled", () => {
    __setMemoryReviewEnabledForTests(false);
    expect(resolveVisibilityScope(undefined)).toBe("active");
    expect(resolveVisibilityScope({ visibility: "active" })).toBe("active");
    expect(resolveVisibilityScope({ visibility: "quarantined" })).toBe("quarantined");
  });

  it("visibility compensation never shrinks an existing retrieval budget", () => {
    expect(withVisibilityOverFetch(600, "active")).toBeGreaterThanOrEqual(600);
    expect(withVisibilityOverFetch(600, "all")).toBe(600);
  });

  // ───────────────────────── 读路径抑制 ─────────────────────────

  it("撤回后，queryL1Records 默认不再返回该记忆；visibility:'all' 仍能看到", () => {
    store.upsertL1(rec({ id: "m_keep", content: "用户偏好 A" }), undefined);
    store.upsertL1(rec({ id: "m_bad", content: "用户偏好 B（错误）" }), undefined);

    const before = store.queryL1Records({ ...ISO });
    expect(before.map((r) => r.record_id).sort()).toEqual(["m_bad", "m_keep"]);

    const res = store.setL1ReviewStatus("m_bad", "quarantined", ISO);
    expect(res).toMatchObject({ changed: true, previous: "active" });

    const after = store.queryL1Records({ ...ISO });
    expect(after.map((r) => r.record_id)).toEqual(["m_keep"]);

    // 审计/审核台通道：必须仍然看得见（DP-13）
    const audited = store.queryL1Records({ ...ISO, visibility: "all" });
    expect(audited.map((r) => r.record_id).sort()).toEqual(["m_bad", "m_keep"]);

    const onlyBad = store.queryL1Records({ ...ISO, visibility: "quarantined" });
    expect(onlyBad.map((r) => r.record_id)).toEqual(["m_bad"]);
  });

  it("one query path intersects session key/id predicates without changing isolation", () => {
    store.upsertL1(rec({ id: "match", content: "matched", sessionKey: "sk-a", sessionId: "ses-a" }), undefined);
    store.upsertL1(rec({ id: "other-key", content: "other", sessionKey: "sk-b", sessionId: "ses-a" }), undefined);
    expect(store.queryL1Records({ sessionId: "ses-a", sessionKey: "sk-a" }).map((r) => r.record_id)).toEqual(["match"]);
    expect(store.queryL1Records({ ...ISO, sessionId: "ses-a", sessionKey: "sk-a" }).map((r) => r.record_id)).toEqual(["match"]);
    expect(store.queryL1Records({ sessionId: "ses-a", updatedAfter: "2025-01-01T00:00:00.000Z" })).toHaveLength(2);
    expect(store.queryL1Records({ sessionKey: "sk-b" }).map((r) => r.record_id)).toEqual(["other-key"]);
  });

  it("empty primary-key selections never turn into a full scan", () => {
    store.upsertL1(rec({ id: "not-selected", content: "fact" }), undefined);
    expect(store.queryL1Records({ recordIds: [] })).toEqual([]);
    expect(store.queryL1Records({ ...ISO, recordIds: [] })).toEqual([]);
    expect(store.queryL1Records({ recordIds: [], visibility: "all" }, { review: false })).toEqual([]);
  });

  it("raw audit reads cannot mask an unavailable store as an empty result", () => {
    const state = store as unknown as { degraded: boolean };
    state.degraded = true;
    try { expect(() => store.queryL1Records({ visibility: "all" }, { review: false })).toThrow("degraded"); }
    finally { state.degraded = false; }
  });

  it("撤回后 FTS 搜索不再命中；visibility:'all' 仍命中（FTS 表没有状态列，走回查）", () => {
    store.upsertL1(rec({ id: "m_fts1", content: "kubernetes deployment rollout" }), undefined);
    store.upsertL1(rec({ id: "m_fts2", content: "kubernetes ingress controller" }), undefined);

    const hit0 = store.searchL1Fts("kubernetes", 10, ISO);
    expect(hit0.map((r) => r.record_id).sort()).toEqual(["m_fts1", "m_fts2"]);

    store.setL1ReviewStatus("m_fts2", "quarantined", ISO);

    const hit1 = store.searchL1Fts("kubernetes", 10, ISO);
    expect(hit1.map((r) => r.record_id)).toEqual(["m_fts1"]);

    const hit2 = store.searchL1Fts("kubernetes", 10, { ...ISO, visibility: "all" });
    expect(hit2.map((r) => r.record_id).sort()).toEqual(["m_fts1", "m_fts2"]);
  });

  it("FTS uses authoritative current bytes rather than stale indexed content", () => {
    store.upsertL1(rec({ id: "indexed", content: "kubernetes current verified fact" }), undefined);
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare("UPDATE l1_fts SET content_original = ? WHERE record_id = ?").run("stale sensitive fact", "indexed");
    expect(store.searchL1Fts("kubernetes", 10, ISO)[0]?.content).toBe("kubernetes current verified fact");
  });

  it("restore 之后记忆回到读路径，且可逆（向量/FTS 条目未被删，DP-21）", () => {
    store.upsertL1(rec({ id: "m_r", content: "restore roundtrip 测试内容" }), undefined);
    store.setL1ReviewStatus("m_r", "quarantined", ISO);
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);
    expect(store.searchL1Fts("roundtrip", 10, ISO)).toHaveLength(0);

    const back = store.setL1ReviewStatus("m_r", "active", ISO);
    expect(back).toMatchObject({ changed: true, previous: "quarantined" });
    expect(store.queryL1Records({ ...ISO }).map((r) => r.record_id)).toEqual(["m_r"]);
    // FTS 仍能命中 ⇒ 索引条目确实没被删，restore 不需要重新 embedding
    expect(store.searchL1Fts("roundtrip", 10, ISO).map((r) => r.record_id)).toEqual(["m_r"]);
  });

  // ───────────── DP-14：撤回的记忆必须对去重可见，否则会复活 ─────────────

  it("DP-14 陷阱：若去重路径看不见被撤回的记忆，同一事实会以新 id 复活", () => {
    store.upsertL1(rec({ id: "m_dup", content: "用户的手机号是 13800000000" }), undefined);
    store.setL1ReviewStatus("m_dup", "quarantined", ISO);

    // 模拟去重：抽取器拿到同一事实，先召回已有候选判重。
    // 默认可见性 = active ⇒ 看不到被撤回的那条 ⇒ 会判定为"新记忆"。
    const asRecallPath = store.searchL1Fts("13800000000", 10, ISO);
    expect(asRecallPath).toHaveLength(0); // 这正是复活的成因

    // 去重路径必须显式用 "all"，才能发现"这条已被撤回过"。
    const asDedupPath = store.searchL1Fts("13800000000", 10, { ...ISO, visibility: "all" });
    expect(asDedupPath.map((r) => r.record_id)).toEqual(["m_dup"]);

    // 并且 store 能告诉调用方它是被撤回的 —— 去重据此选择"不复活"。
    const row = store.queryL1Records({ ...ISO, recordIds: ["m_dup"], visibility: "all" })[0];
    expect((row as unknown as { review_status?: string }).review_status).toBe("quarantined");
  });

  it("DP-14 后门：合并更新不得把 review_status 重置回 active（沉默不变量，钉死）", () => {
    store.upsertL1(rec({ id: "m_resurrect", content: "原始内容" }), undefined);
    store.setL1ReviewStatus("m_resurrect", "quarantined", ISO);
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);

    // 去重判定为“重复”后，写入走 ON CONFLICT 更新同一行。
    // 若 upsert 的更新列清单里混进 review_status，被撤回的记忆就会从后门复活。
    store.upsertL1(rec({ id: "m_resurrect", content: "合并后的新内容", version: 2 }), undefined);

    expect(store.queryL1Records({ ...ISO })).toHaveLength(0); // 仍然隔离
    const row = store.queryL1Records({ ...ISO, visibility: "all" })[0];
    expect(row.content).toBe("合并后的新内容");  // 内容确实更新了
    expect((row as unknown as { review_status?: string }).review_status).toBe("quarantined");
  });

  // ───────────── DP-04：超取补偿与召回退化可观测 ─────────────

  it("DP-04 超取补偿：被撤回记忆占满基线超取窗口时，仍能凑满 topK", () => {
    // 规模必须真的撑破基线超取窗口，否则这个测试是空转：
    // limit=5 ⇒ 基线 retrieveLimit = max(5*5, 5) = 25。
    // 造 50 条被撤回 + 10 条正常，并用 bm25 特性把被撤回的排在前面
    //（文档越短 bm25 分越高），使前 25 名全部是被撤回的。
    // 无补偿 ⇒ 取回 25 条全被滤掉 ⇒ 返回 0 条（线上表现为"召回突然为空"）。
    // 有补偿 ⇒ 取回 75 条 ⇒ 够到那 10 条正常记忆 ⇒ 返回 5 条。
    const FILLER = " lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
    for (let i = 0; i < 50; i++) {
      store.upsertL1(rec({ id: `m_q_${i}`, content: "alpha" }), undefined); // 短 ⇒ 排前
    }
    for (let i = 0; i < 10; i++) {
      store.upsertL1(rec({ id: `m_a_${i}`, content: `alpha${FILLER}` }), undefined); // 长 ⇒ 排后
    }
    for (let i = 0; i < 50; i++) store.setL1ReviewStatus(`m_q_${i}`, "quarantined", ISO);

    // 前置校验：确认被撤回的那批确实占据了基线窗口的前 25 名，
    // 否则本测试就退化成空转，必须立刻暴露出来。
    const baselineWindow = store.searchL1Fts("alpha", 25, { ...ISO, visibility: "all" }).slice(0, 25);
    expect(baselineWindow).toHaveLength(25);
    expect(baselineWindow.every((r) => r.record_id.startsWith("m_q_"))).toBe(true);

    const hits = store.searchL1Fts("alpha", 5, ISO);
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.record_id.startsWith("m_a_"))).toBe(true);
  });

  it("DP-04 补偿是有界的，不允许无界超取", () => {
    expect(withVisibilityOverFetch(10, "active")).toBe(30);
    expect(withVisibilityOverFetch(10, "all")).toBe(10);     // 关闭过滤 = 基线行为
    expect(withVisibilityOverFetch(200, "active")).toBe(500);
    expect(withVisibilityOverFetch(1000, "active")).toBe(1000); // 不缩减已有预算
  });

  it("FTS does not expose quarantined content when its visibility lookup fails", () => {
    store.upsertL1(rec({ id: "m_fts_failure", content: "suppression failure" }), undefined);
    store.setL1ReviewStatus("m_fts_failure", "quarantined", ISO);
    vi.spyOn(store, "queryL1Records").mockImplementationOnce(() => { throw new Error("database unavailable"); });
    expect(() => store.searchL1Fts("suppression", 10, ISO)).toThrow("database unavailable");
  });

  it("DP-04 截断信号：过滤后不足请求量且取回窗口被填满 ⇒ 必须报 truncated", () => {
    expect(recallTruncated({ requested: 5, retrieved: 30, retrieveLimit: 30, kept: 2, scope: "active" })).toBe(true);
    // 取回窗口没被填满 ⇒ 库里就这么多，不算截断
    expect(recallTruncated({ requested: 5, retrieved: 7, retrieveLimit: 30, kept: 2, scope: "active" })).toBe(false);
    // 凑满了就不算截断
    expect(recallTruncated({ requested: 5, retrieved: 30, retrieveLimit: 30, kept: 5, scope: "active" })).toBe(false);
    // 没开过滤就不可能是可见性导致的截断
    expect(recallTruncated({ requested: 5, retrieved: 30, retrieveLimit: 30, kept: 2, scope: "all" })).toBe(false);
  });

  // ───────────── 读面穷举：每个 L1 读方法都要有明确口径 ─────────────

  it("DP-25 countL1 默认只数 active —— 否则面板显示“共 100 条”而只能召回 60 条", () => {
    store.upsertL1(rec({ id: "m_c1", content: "a" }), undefined);
    store.upsertL1(rec({ id: "m_c2", content: "b" }), undefined);
    store.setL1ReviewStatus("m_c2", "quarantined", ISO);

    expect(store.countL1({ ...ISO })).toBe(1);
    expect(store.countL1({ ...ISO, visibility: "all" })).toBe(2);
    expect(store.countL1({ ...ISO, visibility: "quarantined" })).toBe(1);
  });

  it("DP-14 第三道门：记忆全被撤回时 countL1 全量仍 > 0，去重不会被整体跳过", () => {
    // l1-dedup 用 countL1() > 0 判断“有没有可比对的数据”。
    // 若它只数 active，一个租户的记忆全被撤回后该判定为 0 ⇒ 跳过去重 ⇒
    // 同一事实以新 id 原样写入 ⇒ 复活。
    store.upsertL1(rec({ id: "m_all_q", content: "唯一的一条，且已被撤回" }), undefined);
    store.setL1ReviewStatus("m_all_q", "quarantined", ISO);

    expect(store.countL1({ ...ISO })).toBe(0);                      // 默认口径确实是 0
    expect(store.countL1({ visibility: "all" })).toBeGreaterThan(0); // 去重用的口径不是 0
  });

  it("DP-26 queryL1Paginated（/atomic/query 数据面读）默认过滤，total 与 rows 口径一致", () => {
    store.upsertL1(rec({ id: "m_p1", content: "p1" }), undefined);
    store.upsertL1(rec({ id: "m_p2", content: "p2" }), undefined);
    store.upsertL1(rec({ id: "m_p3", content: "p3" }), undefined);
    store.setL1ReviewStatus("m_p2", "quarantined", ISO);

    const page = store.queryL1Paginated({ ...ISO, limit: 10, offset: 0 });
    expect(page.rows.map((r) => r.record_id).sort()).toEqual(["m_p1", "m_p3"]);
    // total 必须与 rows 同口径，否则分页会出现“翻不到的第 3 条”
    expect(page.total).toBe(2);

    const auditPage = store.queryL1Paginated({ ...ISO, limit: 10, offset: 0, visibility: "all" });
    expect(auditPage.total).toBe(3);
  });

  it("DP-27 queryL1RecordsCursor（导出/迁移）刻意不过滤，但行里带 review_status", () => {
    store.upsertL1(rec({ id: "m_x1", content: "导出1" }), undefined);
    store.upsertL1(rec({ id: "m_x2", content: "导出2" }), undefined);
    store.setL1ReviewStatus("m_x2", "quarantined", ISO);

    const all = store.queryL1RecordsCursor("", 100);
    // 迁移不得静默丢数据 —— 丢了等于把被撤回的记忆洗白成不存在
    expect(all.map((r) => r.record_id).sort()).toEqual(["m_x1", "m_x2"]);
    const q = all.find((r) => r.record_id === "m_x2") as unknown as { review_status?: string };
    expect(q.review_status).toBe("quarantined");  // 调用方能自行判断
  });

  it("getAllL1Texts 返回形状没有状态字段 ⇒ 只给 active（fail-safe）", () => {
    store.upsertL1(rec({ id: "m_t1", content: "文本1" }), undefined);
    store.upsertL1(rec({ id: "m_t2", content: "文本2" }), undefined);
    store.setL1ReviewStatus("m_t2", "quarantined", ISO);

    const texts = store.getAllL1Texts();
    expect(texts.map((t) => t.record_id)).toEqual(["m_t1"]);
  });

  // ───────────── DP-18 / DP-09 写入侧语义 ─────────────

  it("DP-18 同身份重试不重复提交，独立撤回不被当前状态吞掉", () => {
    store.upsertL1(rec({ id: "m_i", content: "幂等测试" }), undefined);
    const operation = { operation_id: `rop-${"a".repeat(64)}` };
    const first = store.setL1ReviewStatus("m_i", "quarantined", ISO, operation);
    expect(first).toMatchObject({ changed: true, previous: "active" });
    expect(store.setL1ReviewStatus("m_i", "quarantined", ISO, operation)).toEqual(first);
    expect(store.setL1ReviewStatus("m_i", "quarantined", ISO, { operation_id: `rop-${"b".repeat(64)}` })).toMatchObject({ changed: true, previous: "quarantined" });
    expect(store.queryMemoryEvents({ record_id: "m_i", op: "retracted" })).toHaveLength(2);
  });

  it("DP-09 跨租户不得撤回：租户不匹配返回 undefined，记忆保持可见", () => {
    store.upsertL1(rec({ id: "m_t", content: "租户隔离测试" }), undefined);
    expect(store.setL1ReviewStatus("m_t", "quarantined", { teamId: "t1", userId: "OTHER", agentId: "a1" })).toBeUndefined();
    expect(store.queryL1Records({ ...ISO }).map((r) => r.record_id)).toEqual(["m_t"]);
  });

  it("不存在的 record 返回 undefined，而不是假装成功", () => {
    expect(store.setL1ReviewStatus("m_nope", "quarantined", ISO)).toBeUndefined();
  });

  it("legacy absent status is active, but unknown nonempty status fails closed", () => {
    expect(rowMatchesVisibility({}, "active")).toBe(true);
    expect(rowMatchesVisibility({ review_status: "unexpected" }, "active")).toBe(false);
    expect(rowMatchesVisibility({ review_status: "unexpected" }, "quarantined")).toBe(true);
  });

  // ───────────── DP-23 开关关闭 = 基线行为 ─────────────

  it("关闭审核写入口不能复活已撤回的记忆", () => {
    // 注意用 ASCII 词元：sqlite FTS5 默认 unicode61 分词器不切中文，
    // 整串中文做 MATCH 查询匹配不上 —— 这是基线既有行为，与本机制无关。
    store.upsertL1(rec({ id: "m_flag", content: "featureflag switch content" }), undefined);
    store.setL1ReviewStatus("m_flag", "quarantined", ISO);
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);

    __setMemoryReviewEnabledForTests(false);
    expect(store.queryL1Records({ ...ISO })).toEqual([]);
    expect(store.searchL1Fts("featureflag", 10, ISO)).toEqual([]);
    // 关闭时超取也回落到基线值，不产生额外查询开销
    expect(withVisibilityOverFetch(10, "all")).toBe(10);
  });

  it("内部审核事件不因关闭 HTTP 写入口而失去读保护", () => {
    __setMemoryReviewEnabledForTests(false);
    store.upsertL1(rec({ id: "m_pre", content: "灰度前预置" }), undefined);
    expect(store.setL1ReviewStatus("m_pre", "quarantined", ISO)).toMatchObject({ changed: true, previous: "active" });
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);
    __setMemoryReviewEnabledForTests(true);
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);
  });
});
