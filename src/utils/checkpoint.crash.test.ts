/**
 * Checkpoint 崩溃恢复测试 — atomic write + tmp 文件处理 + 异常恢复
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager crash recovery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `cp-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** 模拟写入中途崩溃：写入 tmp 文件但不 rename */
  async function simulateMidWriteCrash(
    dir: string,
    _content: string,
  ): Promise<void> {
    const metaDir = path.join(dir, ".metadata");
    await fs.mkdir(metaDir, { recursive: true });
    // 写入一个残留的 tmp 文件（模拟崩溃场景）
    await fs.writeFile(
      path.join(metaDir, "recall_checkpoint.json.tmp.deadbeef"),
      '{"l0_conversations_count": 999, "total_memories_extracted": 888}',
    );
  }

  it("survives mid-write crash: tmp file exists but main file intact", async () => {
    // 先写入一个正常的 checkpoint
    const mgr = new CheckpointManager(tmpDir);
    await mgr.write({
      ...(await mgr.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    // 模拟崩溃：残留 tmp 文件
    await simulateMidWriteCrash(tmpDir, "garbage");

    // 重新读取 — 应该读到主文件，不受 tmp 影响
    const mgr2 = new CheckpointManager(tmpDir);
    const cp = await mgr2.read();
    expect(cp.l0_conversations_count).toBe(100);
    expect(cp.total_memories_extracted).toBe(50);

    // recalibrate 应该成功（覆盖旧值 + 清理 tmp）
    const result = await mgr2.recalibrate({ l0Count: 80, l1Count: 40 });
    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);
  });

  it("atomic rename preserves data integrity", async () => {
    const mgr = new CheckpointManager(tmpDir);

    // 并行写入以验证原子性
    const writes = Array.from({ length: 5 }, (_, i) =>
      mgr.write({
        last_captured_timestamp: 0,
        total_processed: i * 100,
        last_persona_at: 0,
        last_persona_time: "",
        request_persona_update: false,
        persona_update_reason: "",
        memories_since_last_persona: 0,
        scenes_processed: 0,
        runner_states: {},
        pipeline_states: {},
        l0_conversations_count: i,
        total_memories_extracted: i * 10,
      }),
    );

    await Promise.all(writes);

    const onDisk = await mgr.read();
    // 最后一次写入的值应该一致（不能是部分更新的中间态）
    expect(onDisk.total_processed % 100).toBe(0); // 必须是 100 的倍数
    expect(onDisk.l0_conversations_count * 10).toBe(onDisk.total_memories_extracted);
  });

  it("recovers from truncated checkpoint JSON", async () => {
    const metaDir = path.join(tmpDir, ".metadata");
    await fs.mkdir(metaDir, { recursive: true });
    // 写入截断的 JSON
    await fs.writeFile(
      path.join(metaDir, "recall_checkpoint.json"),
      '{"l0_conversations_count": 100, "total_memories_extracted',
    );

    const mgr = new CheckpointManager(tmpDir);
    // 读应该回退到默认值，不崩溃
    const cp = await mgr.read();
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.total_processed).toBe(0);
  });

  it("write succeeds even when .metadata/ directory does not exist", async () => {
    // tmpDir 下没有 .metadata/ 目录
    const mgr = new CheckpointManager(tmpDir);
    const result = await mgr.recalibrate({ l0Count: 42, l1Count: 17 });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    // 确认目录被创建
    const stat = await fs.stat(path.join(tmpDir, ".metadata"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("large checkpoint JSON writes without truncation", async () => {
    const mgr = new CheckpointManager(tmpDir);
    // 模拟大型 checkpoint: 100 个 session 的状态
    const runnerStates: Record<string, any> = {};
    const pipelineStates: Record<string, any> = {};
    for (let i = 0; i < 100; i++) {
      runnerStates[`session-${i}`] = {
        last_captured_timestamp: Date.now() + i * 1000,
        last_l1_cursor: Date.now() - i * 1000,
        last_scene_name: `scene-${i % 10}`,
      };
      pipelineStates[`session-${i}`] = {
        conversation_count: i,
        last_extraction_time: new Date().toISOString(),
        last_extraction_updated_time: "",
        last_active_time: Date.now(),
        l2_pending_l1_count: i % 5,
        warmup_threshold: i < 10 ? i : 0,
        l2_last_extraction_time: "",
      };
    }

    await mgr.write({
      last_captured_timestamp: Date.now(),
      total_processed: 99999,
      last_persona_at: 50000,
      last_persona_time: new Date().toISOString(),
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 1234,
      scenes_processed: 567,
      runner_states: runnerStates,
      pipeline_states: pipelineStates,
      l0_conversations_count: 500,
      total_memories_extracted: 10000,
    });

    // 读回并验证完整性
    const cp = await mgr.read();
    expect(cp.total_processed).toBe(99999);
    expect(Object.keys(cp.runner_states)).toHaveLength(100);
    expect(Object.keys(cp.pipeline_states)).toHaveLength(100);
  });
});
