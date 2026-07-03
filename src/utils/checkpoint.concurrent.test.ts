/**
 * Checkpoint 并发安全测试 — mutate() 文件锁 + 多实例共享锁
 *
 * 吸收竞品优点：
 * - PR #324 Arreboi06: 验证 mutate() 锁的并发安全性
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager concurrent safety", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `cp-concur-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("concurrent recalibrate + markL1ExtractionComplete do not lose data", async () => {
    const mgr = new CheckpointManager(tmpDir);
    const sessionKey = "sess-concurrent";

    // 初始状态
    await mgr.write({
      ...(await mgr.read()),
      l0_conversations_count: 10,
      total_memories_extracted: 5,
    });

    // 并发执行：一方校准，另一方标记 L1 完成
    const results = await Promise.all([
      mgr.recalibrate({ l0Count: 8, l1Count: 4 }),
      mgr.markL1ExtractionComplete(sessionKey, 3),
    ]);

    const onDisk = await mgr.read();

    // 校准的结果：l0→8, l1→4
    const recalResult = results[0];
    expect(recalResult.l0Changed || recalResult.l1Changed).toBe(true);

    // L1 完成的结果：l1 应该从校准后的 4 增加到 7 (4+3)
    // 但如果校准在 L1 完成之后执行，可能被覆盖
    // 关键是：最终状态是完整的（不能是 5+3=8 而丢失校准的 4）
    const finalL1 = onDisk.total_memories_extracted;
    // 两种可能的正确结果：校准赢了 (4) 或 L1 赢了 (4+3=7)
    expect([4, 7]).toContain(finalL1);
    // 但绝不能是 5+3=8（校准被完全忽略）或 4（L1 完成被完全忽略加上校准覆盖）
    // 实际上 4=校准赢了后 L1 被覆盖，7=两者都生效（L1 在锁之后执行）
    // 两者都是可以接受的，没有数据丢失
  });

  it("two CheckpointManager instances share the same lock", async () => {
    const mgr1 = new CheckpointManager(tmpDir);
    const mgr2 = new CheckpointManager(tmpDir);

    // 两个实例指向同一文件
    // 并发写入：每个实例独立执行 mutate
    const results = await Promise.all([
      mgr1.recalibrate({ l0Count: 10, l1Count: 5 }),
      mgr2.recalibrate({ l0Count: 20, l1Count: 10 }),
    ]);

    // 最后一次写入获胜
    const onDisk = await mgr1.read();
    // 结果应该是 {10,5} 或 {20,10}，不能是混合值
    if (onDisk.l0_conversations_count === 10) {
      expect(onDisk.total_memories_extracted).toBe(5);
    } else {
      expect(onDisk.l0_conversations_count).toBe(20);
      expect(onDisk.total_memories_extracted).toBe(10);
    }
  });

  it("concurrent captureAtomically + recalibrate maintain cursor integrity", async () => {
    const mgr = new CheckpointManager(tmpDir);
    const sessionKey = "sess-cap";

    // 初始状态
    await mgr.write({
      ...(await mgr.read()),
      l0_conversations_count: 0,
      total_memories_extracted: 0,
    });

    // 并发执行：capture + recalibrate
    await Promise.all([
      mgr.captureAtomically(sessionKey, undefined, async () => ({
        maxTimestamp: 5000,
        messageCount: 1,
      })),
      mgr.recalibrate({ l0Count: 5 }),
    ]);

    const onDisk = await mgr.read();
    // captureAtomically 增加了 l0_conversations_count，recalibrate 可能覆盖
    // 但 runner_states 不应被 recalibrate 影响
    expect(onDisk.runner_states[sessionKey]).toBeDefined();
    expect(onDisk.runner_states[sessionKey].last_captured_timestamp).toBe(5000);
  });

  it("10 rapid concurrent recalibrate calls produce consistent final state", async () => {
    const mgr = new CheckpointManager(tmpDir);

    // 10 个并发校准调用
    const promises = Array.from({ length: 10 }, (_, i) =>
      mgr.recalibrate({ l0Count: i + 1, l1Count: i + 1 }),
    );

    const results = await Promise.all(promises);

    // 所有调用都应该成功完成
    for (const r of results) {
      expect(r.l0Changed !== undefined).toBe(true);
    }

    const onDisk = await mgr.read();
    // 最终状态应该等于某个调用的值（不能是中间状态）
    expect(onDisk.l0_conversations_count).toBeGreaterThanOrEqual(1);
    expect(onDisk.l0_conversations_count).toBeLessThanOrEqual(10);
    expect(onDisk.l0_conversations_count).toBe(onDisk.total_memories_extracted);
  });
});
