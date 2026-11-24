/**
 * L1 复合游标回归测试（issue #1979）。
 *
 * 同一毫秒内的 L0 行数超过单页 LIMIT 时，只按 `recorded_at > cursor` 推进会
 * 把剩余行永久跳过。这里用真实的 SQLite 存储验证：
 *   - 旧语义（不传 record_id）确实会漏；
 *   - 复合游标能读到全部剩余行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";

const SESSION = "sk-cursor";
const MS = Date.parse("2026-01-01T00:00:00.000Z");

function row(id: string, recordedAtMs: number) {
  return {
    id,
    sessionKey: SESSION,
    sessionId: "sid-cursor",
    role: "user" as const,
    messageText: id,
    recordedAt: new Date(recordedAtMs).toISOString(),
    timestamp: recordedAtMs,
  };
}

describe("L1 cursor with same-millisecond rows", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tdai-l0-cursor-"));
    store = new VectorStore(path.join(dir, "memory.db"), 0);
    const init = store.init();
    expect(init.reason ?? "").not.toContain("failed");
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("composite cursor reads every row when one millisecond exceeds the page size", () => {
    // 25 行同一毫秒 + 1 行晚 1ms
    for (let i = 0; i < 25; i++) {
      expect(store.upsertL0(row(`l0_same_${String(i).padStart(2, "0")}`, MS), undefined)).toBe(true);
    }
    expect(store.upsertL0(row("l0_next", MS + 1), undefined)).toBe(true);

    const page1 = store.queryL0ForL1(SESSION, undefined, 20);
    expect(page1).toHaveLength(20);
    const last = page1[page1.length - 1]!;
    expect(last.record_id).toBe("l0_same_19");

    // 旧语义：只按 recorded_at 推进 → 剩余 5 行同毫秒数据被跳过
    const legacy = store.queryL0ForL1(SESSION, MS, 20);
    expect(legacy.map((r) => r.record_id)).toEqual(["l0_next"]);

    // 复合游标：同一毫秒内用 record_id 继续推进
    const page2 = store.queryL0ForL1(SESSION, MS, 20, last.record_id);
    expect(page2.map((r) => r.record_id)).toEqual([
      "l0_same_20",
      "l0_same_21",
      "l0_same_22",
      "l0_same_23",
      "l0_same_24",
      "l0_next",
    ]);
  });
});
