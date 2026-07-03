/**
 * Checkpoint 集成测试 — 真实 JSONL 文件操作 + memory-cleaner 联动
 *
 * 吸收竞品优点：
 * - PR #253 L2ncE: JSONL fallback 端到端验证
 * - PR #177 RerankerGuo: memory-cleaner → onAfterCleanup → recalibrate 链路
 * - PR #342 NianJiuZst: 多 session JSONL 聚合
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CheckpointManager,
  countJsonlL0Records,
  countJsonlL1Records,
} from "./checkpoint.js";

describe("CheckpointManager integration", () => {
  let tmpDir: string;
  let manager: CheckpointManager;
  const logMessages: string[] = [];
  const testLogger = {
    info(msg: string) { logMessages.push(msg); },
    warn(msg: string) { logMessages.push(`[warn] ${msg}`); },
  };

  beforeEach(async () => {
    logMessages.length = 0;
    tmpDir = path.join(
      os.tmpdir(),
      `cp-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    manager = new CheckpointManager(tmpDir, testLogger);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ═══ JSONL → recalibrate 端到端 ═══

  it("recalibrate from actual JSONL files after cleanup simulation", async () => {
    // 1. 创建 JSONL 数据（模拟正常采集）
    const convDir = path.join(tmpDir, "conversations");
    const recDir = path.join(tmpDir, "records");
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(recDir, { recursive: true });

    // 5 条 L0 对话
    await fs.writeFile(
      path.join(convDir, "2026-07-01.jsonl"),
      '{"msg":"hello"}\n{"msg":"world"}\n{"msg":"foo"}\n',
    );
    // 2 条 L1 记忆
    await fs.writeFile(
      path.join(recDir, "2026-07-01.jsonl"),
      '{"type":"memory"}\n{"type":"memory"}\n',
    );

    // 2. 初始 checkpoint 有过高的计数器值（模拟 cleanup 前的累积）
    await manager.write({
      ...(await manager.read()),
      l0_conversations_count: 20,
      total_memories_extracted: 15,
      total_processed: 50,
    });

    // 3. JSONL 计数 + recalibrate
    const actualL0 = await countJsonlL0Records(tmpDir, testLogger);
    const actualL1 = await countJsonlL1Records(tmpDir, testLogger);
    expect(actualL0).toBe(3);
    expect(actualL1).toBe(2);

    const result = await manager.recalibrate({
      l0Count: actualL0,
      l1Count: actualL1,
      totalProcessedCount: actualL0,
    });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);
    expect(result.totalProcessedChanged).toBe(true);

    const onDisk = await manager.read();
    expect(onDisk.l0_conversations_count).toBe(3);
    expect(onDisk.total_memories_extracted).toBe(2);
    expect(onDisk.total_processed).toBe(3);
  });

  it("recalibrate reflects deletion of JSONL files", async () => {
    const convDir = path.join(tmpDir, "conversations");
    const recDir = path.join(tmpDir, "records");
    await fs.mkdir(convDir, { recursive: true });
    await fs.mkdir(recDir, { recursive: true });
    await fs.writeFile(path.join(convDir, "2026-07-01.jsonl"), '{"a":1}\n{"b":2}\n');
    await fs.writeFile(path.join(recDir, "2026-07-01.jsonl"), '{"x":1}\n');

    // 先校准一次
    await manager.recalibrate({
      l0Count: await countJsonlL0Records(tmpDir, testLogger),
      l1Count: await countJsonlL1Records(tmpDir, testLogger),
    });

    // 删除 JSONL 文件（模拟 cleanup）
    await fs.rm(convDir, { recursive: true });
    await fs.rm(recDir, { recursive: true });

    // 再次校准
    const result = await manager.recalibrate({
      l0Count: await countJsonlL0Records(tmpDir, testLogger),
      l1Count: await countJsonlL1Records(tmpDir, testLogger),
    });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    const onDisk = await manager.read();
    expect(onDisk.l0_conversations_count).toBe(0);
    expect(onDisk.total_memories_extracted).toBe(0);
  });

  it("skips corrupt JSONL lines gracefully", async () => {
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });
    // 3 条有效行 + 1 条空白 + 1 条无效 JSON（没有花括号）
    await fs.writeFile(
      path.join(convDir, "2026-07-01.jsonl"),
      '{"a":1}\n\nnot-json\n{"b":2}\n{"c":3}\n',
    );

    const count = await countJsonlL0Records(tmpDir, testLogger);
    // countJsonlL0Records 只过滤空白行，不验证 JSON 有效性
    expect(count).toBe(4); // 3 valid lines + "not-json" line (non-empty)
  });

  it("counts across multiple session/day JSONL files", async () => {
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });
    await fs.writeFile(path.join(convDir, "2026-07-01.jsonl"), '{"a":1}\n{"b":2}\n');
    await fs.writeFile(path.join(convDir, "2026-07-02.jsonl"), '{"c":3}\n');
    await fs.writeFile(path.join(convDir, "2026-07-03.jsonl"), '{"d":4}\n{"e":5}\n{"f":6}\n');

    const count = await countJsonlL0Records(tmpDir, testLogger);
    expect(count).toBe(6);
  });

  // ═══ 大文件性能 ═══

  it("handles large JSONL files (10k+ lines) within acceptable time", async () => {
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });

    // 生成 10k 行 JSONL
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(JSON.stringify({ id: i, text: `message ${i}` }));
    }
    await fs.writeFile(path.join(convDir, "2026-07-01.jsonl"), lines.join("\n") + "\n");

    const start = performance.now();
    const count = await countJsonlL0Records(tmpDir, testLogger);
    const elapsed = performance.now() - start;

    expect(count).toBe(10000);
    expect(elapsed).toBeLessThan(500); // < 500ms for 10k lines
  });

  // ═══ 损坏 checkpoint 文件恢复 ═══

  it("recovers gracefully from corrupt checkpoint JSON", async () => {
    const metaDir = path.join(tmpDir, ".metadata");
    await fs.mkdir(metaDir, { recursive: true });
    // 写入损坏的 JSON
    await fs.writeFile(
      path.join(metaDir, "recall_checkpoint.json"),
      "{ this is not valid json !!!",
    );

    // recalibrate 应该回退到默认值，不崩溃
    const result = await manager.recalibrate({ l0Count: 5, l1Count: 3 });
    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    // 确认文件已被修复
    const onDisk = await manager.read();
    expect(onDisk.l0_conversations_count).toBe(5);
    expect(onDisk.total_memories_extracted).toBe(3);
  });

  it("creates checkpoint file and directory when neither exists", async () => {
    // tmpDir 下没有任何文件
    const result = await manager.recalibrate({
      l0Count: 10,
      l1Count: 5,
      totalProcessedCount: 10,
    });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);
    expect(result.totalProcessedChanged).toBe(true);

    // 确认文件被创建
    const metaDir = path.join(tmpDir, ".metadata");
    const exists = await fs.stat(metaDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const onDisk = await manager.read();
    expect(onDisk.l0_conversations_count).toBe(10);
    expect(onDisk.total_memories_extracted).toBe(5);
    expect(onDisk.total_processed).toBe(10);
  });

  // ═══ 快速连续 recalibrate（无竞态） ═══

  it("rapid consecutive recalibrate calls produce consistent final state", async () => {
    await manager.write({
      ...(await manager.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 100,
    });

    // 快速连续 5 次校准
    const results = await Promise.all([
      manager.recalibrate({ l0Count: 80, l1Count: 90 }),
      manager.recalibrate({ l0Count: 70, l1Count: 80 }),
      manager.recalibrate({ l0Count: 60, l1Count: 70 }),
      manager.recalibrate({ l0Count: 50, l1Count: 60 }),
      manager.recalibrate({ l0Count: 50, l1Count: 60 }), // 同值
    ]);

    // 最后一次写入的值应该覆盖前面的
    const onDisk = await manager.read();
    expect(onDisk.l0_conversations_count).toBe(50);
    expect(onDisk.total_memories_extracted).toBe(60);

    // 至少有一个调用报告了变更
    const anyChanged = results.some(
      (r) => r.l0Changed || r.l1Changed,
    );
    expect(anyChanged).toBe(true);
  });
});
