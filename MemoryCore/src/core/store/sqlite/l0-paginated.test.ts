// queryL0Paginated 回归（v2 /v2/conversation/query 的分页路径）：
// session 过滤（session_key=? OR session_id=?）、排序（timestamp 新→旧）、
// limit/offset 分页、total 计数，以及驱动索引 idx_l0_user_agent_ts 的存在性。
// 索引动机：无该索引时计划器选 (user_id, agent_id, session_id) 等值扫 + 每次
// ORDER BY 重建 TEMP B-TREE，分页与计数随历史线性变慢（副本实测 21.5ms→5.9ms）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore } from "./memory-store.js";
import type { L0Record } from "../types.js";

let dir: string;
let store: VectorStore;

const rec = (id: string, sessionKey: string, ts: number, extra: Partial<L0Record> = {}): L0Record => ({
  id,
  sessionKey,
  sessionId: "default",
  role: "user",
  messageText: `msg-${id}`,
  recordedAt: new Date(ts).toISOString(),
  timestamp: ts,
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdai-l0page-"));
  store = new VectorStore(join(dir, "vectors.db"), 4);
  store.init();
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("queryL0Paginated（分页/过滤/排序语义 + 驱动索引）", () => {
  it("session 过滤：session_key 或 session_id 命中皆可，未命中剔除", () => {
    // sess-A：session_key 命中；sess-B：session_id 命中；sess-C：都不命中
    store.upsertL0(rec("a1", "sess-A", 1000), undefined);
    store.upsertL0(rec("b1", "sess-B", 2000, { sessionId: "sess-B" }), undefined);
    store.upsertL0(rec("c1", "sess-C", 3000), undefined);

    const byKey = store.queryL0Paginated({ sessionId: "sess-A", limit: 10, offset: 0 });
    expect(byKey.rows.map((r) => r.record_id)).toEqual(["a1"]);
    expect(byKey.total).toBe(1);

    const byId = store.queryL0Paginated({ sessionId: "sess-B", limit: 10, offset: 0 });
    expect(byId.rows.map((r) => r.record_id)).toEqual(["b1"]);
    expect(byId.total).toBe(1);

    const none = store.queryL0Paginated({ sessionId: "nope", limit: 10, offset: 0 });
    expect(none.rows).toEqual([]);
    expect(none.total).toBe(0);
  });

  it("排序 + limit/offset 分页：timestamp 新→旧，两页不相交且并集=全量", () => {
    for (let i = 1; i <= 7; i++) store.upsertL0(rec(`m${i}`, "sess-A", i * 1000), undefined);
    const p1 = store.queryL0Paginated({ sessionId: "sess-A", limit: 3, offset: 0 });
    const p2 = store.queryL0Paginated({ sessionId: "sess-A", limit: 3, offset: 3 });
    const p3 = store.queryL0Paginated({ sessionId: "sess-A", limit: 3, offset: 6 });
    expect(p1.rows.map((r) => r.record_id)).toEqual(["m7", "m6", "m5"]);
    expect(p2.rows.map((r) => r.record_id)).toEqual(["m4", "m3", "m2"]);
    expect(p3.rows.map((r) => r.record_id)).toEqual(["m1"]);
    expect(p1.total).toBe(7);
    // offset 越界：空页但 total 不变
    const over = store.queryL0Paginated({ sessionId: "sess-A", limit: 3, offset: 99 });
    expect(over.rows).toEqual([]);
    expect(over.total).toBe(7);
  });

  it("时间窗叠加（isolation 默认值不漏不过）", () => {
    store.upsertL0(rec("t1", "sess-A", 1000), undefined);
    store.upsertL0(rec("t2", "sess-A", 5000), undefined);
    store.upsertL0(rec("t3", "sess-A", 9000), undefined);
    const win = store.queryL0Paginated({
      sessionId: "sess-A",
      timeStartMs: 2000,
      timeEndMs: 8000,
      limit: 10,
      offset: 0,
    });
    expect(win.rows.map((r) => r.record_id)).toEqual(["t2"]);
    expect(win.total).toBe(1);
  });

  it("驱动索引 idx_l0_user_agent_ts 在 init 时创建", () => {
    const idx = (
      store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }
    ).db
      .prepare("select name from sqlite_master where type='index' and name=?")
      .get("idx_l0_user_agent_ts");
    expect(idx).toBeTruthy();
  });

  it("机制级断言：分页计划真的走 idx_l0_user_agent_ts，且不再重建排序（#1491 review）", () => {
    // 索引“存在”不等于“被用”：EXPLAIN QUERY PLAN 才能证明机制。
    // queryL0Paginated 的分页 SQL 形状（user/agent 等值过滤 + ORDER BY
    // timestamp DESC + LIMIT/OFFSET）正是该索引 (user_id, agent_id, timestamp
    // DESC) 能直接满足的形状——planner 应选它，且因为索引自带顺序而不必
    // 重建 TEMP B-TREE。
    for (let i = 0; i < 300; i++) {
      store.upsertL0(
        rec(`p${i}`, "sess-P", 1_700_000_000_000 + i, { userId: "default", agentId: "default" }),
        undefined,
      );
    }
    const db = (
      store as unknown as {
        db: { prepare: (s: string) => { all: (...a: unknown[]) => Array<{ detail: string }> } };
      }
    ).db;

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT record_id FROM l0_conversations WHERE user_id = ? AND agent_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      )
      .all("default", "default", 50, 0)
      .map((r) => r.detail)
      .join(" | ");

    expect(plan, `分页计划未使用驱动索引：${plan}`).toContain("idx_l0_user_agent_ts");
    expect(plan, `分页计划仍在重建排序：${plan}`).not.toContain("TEMP B-TREE");
  });

  it("反向对照：不匹配索引形状的查询不会命中该索引（断言非恒真）", () => {
    // session 过滤是 (session_key=? OR session_id=?) 的 OR 形状，索引前两列
    // （user_id, agent_id）对不上——planner 不应选该索引。锁住这一点，上一条
    // 断言才真的在验证机制而不是碰巧恒真。
    for (let i = 0; i < 300; i++) {
      store.upsertL0(
        rec(`q${i}`, "sess-Q", 1_700_000_000_000 + i, { userId: "default", agentId: "default" }),
        undefined,
      );
    }
    const db = (
      store as unknown as {
        db: { prepare: (s: string) => { all: (...a: unknown[]) => Array<{ detail: string }> } };
      }
    ).db;

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT record_id FROM l0_conversations WHERE (session_key = ? OR session_id = ?) ORDER BY timestamp DESC LIMIT ?`,
      )
      .all("sess-Q", "sess-Q", 50)
      .map((r) => r.detail)
      .join(" | ");

    expect(plan, `OR 形状查询不该声称走了该索引：${plan}`).not.toContain("idx_l0_user_agent_ts");
  });
});
