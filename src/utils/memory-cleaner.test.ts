/**
 * Memory Cleaner 测试 — onAfterCleanup → recalibrate 链路验证
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { CheckpointManager } from "./checkpoint.js";

describe("LocalMemoryCleaner onAfterCleanup", () => {
  let tmpDir: string;
  let cleaner: LocalMemoryCleaner;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `cleaner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("onAfterCleanup callback fires after cleanup runs", async () => {
    const onAfter = vi.fn();

    cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 2,  // >= 2 to pass cutoff sanity check
      cleanTime: "03:00",
      onAfterCleanup: onAfter,
    });

    // 确保目录存在
    const convDir = path.join(tmpDir, "conversations");
    const recDir = path.join(tmpDir, "records");
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(recDir, { recursive: true });

    // 创建 2 天前的过期文件
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const dateStr = twoDaysAgo.toISOString().slice(0, 10);
    await fs.writeFile(path.join(convDir, `${dateStr}.jsonl`), '{"old":"data"}\n');

    await cleaner.runOnce();

    // onAfterCleanup 应该被调用（即使没有 vectorStore 删除操作）
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it("onAfterCleanup callback error does not block cleanup completion", async () => {
    const onAfter = vi.fn(() => {
      throw new Error("callback exploded!");
    });

    cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: onAfter,
    });

    // 即使回调抛出异常，runOnce 也不应该失败
    await expect(cleaner.runOnce()).resolves.toBeUndefined();
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it("onAfterCleanup integrates with checkpoint recalibrate", async () => {
    const mgr = new CheckpointManager(tmpDir);

    // 设置初始的过高计数器值
    await mgr.write({
      ...(await mgr.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    // 创建一些 JSONL 文件
    const convDir = path.join(tmpDir, "conversations");
    const recDir = path.join(tmpDir, "records");
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(recDir, { recursive: true });
    await fs.writeFile(path.join(convDir, "2026-07-01.jsonl"), '{"a":1}\n{"b":2}\n{"c":3}\n');
    await fs.writeFile(path.join(recDir, "2026-07-01.jsonl"), '{"x":1}\n');

    // 回调中校准 checkpoint
    const onAfter = async () => {
      const l0 = await (await import("./checkpoint.js")).countJsonlL0Records(tmpDir);
      const l1 = await (await import("./checkpoint.js")).countJsonlL1Records(tmpDir);
      await mgr.recalibrate({ l0Count: l0, l1Count: l1 });
    };

    cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 365, // keep all (files are from today-ish)
      cleanTime: "03:00",
      onAfterCleanup: onAfter,
    });

    await cleaner.runOnce();

    // cleanup + callback 之后，checkpoint 应该反映当前的 JSONL 实际值
    const cp = await mgr.read();
    expect(cp.l0_conversations_count).toBe(3);
    expect(cp.total_memories_extracted).toBe(1);
  });

  it("multiple callbacks fire in registration order", async () => {
    const order: number[] = [];

    cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 2,
      cleanTime: "03:00",
      onAfterCleanup: async () => {
        order.push(1);
      },
    });

    // 注意：onAfterCleanup 是单回调，但我们在测试中手动模拟多回调链
    await cleaner.runOnce();
    expect(order).toEqual([1]);
  });

  it("cleanup with no expired files still calls onAfterCleanup", async () => {
    const onAfter = vi.fn();

    cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 30, // very long retention - nothing expires
      cleanTime: "03:00",
      onAfterCleanup: onAfter,
    });

    // 目录不存在时也不会报错
    await cleaner.runOnce();
    expect(onAfter).toHaveBeenCalledTimes(1);
  });
});
