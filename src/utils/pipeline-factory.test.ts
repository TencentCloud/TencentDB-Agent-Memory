import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryTdaiConfig } from "../config.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import type { LLMRunner } from "../core/types.js";
import { CheckpointManager } from "./checkpoint.js";

vi.mock("../core/scene/scene-extractor.js", () => ({
  SceneExtractor: class {
    constructor(private readonly opts: { dataDir: string }) {}

    async extract(): Promise<{ success: boolean; memoriesProcessed: number }> {
      const manager = new CheckpointManager(this.opts.dataDir);
      await manager.applyCleanupDelta({ removedL0: 4, removedL1: 2, reason: "l2-test-cleanup" });
      return { success: true, memoriesProcessed: 1 };
    }
  },
}));

import { createL2Runner } from "./pipeline-factory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("L2 checkpoint protection", () => {
  it("does not restore counters that legitimately decreased during cleanup", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "l2-checkpoint-test-"));
    tempDirs.push(dataDir);
    const checkpoint = new CheckpointManager(dataDir);
    const cp = await checkpoint.read();
    cp.total_processed = 10;
    cp.l0_conversations_count = 10;
    cp.total_memories_extracted = 5;
    cp.memories_since_last_persona = 5;
    cp.scenes_processed = 2;
    await checkpoint.write(cp);

    const record: L1RecordRow = {
      record_id: "m1",
      content: "memory",
      type: "fact",
      priority: 1,
      scene_name: "scene",
      session_key: "s",
      session_id: "sid",
      timestamp_str: "",
      timestamp_start: "",
      timestamp_end: "",
      created_time: "2026-01-01T00:00:00.000Z",
      updated_time: "2026-01-02T00:00:00.000Z",
      metadata_json: "{}",
    };
    const store = {
      isDegraded: () => false,
      queryL1Records: () => [record],
    } as unknown as IMemoryStore;
    const cfg = {
      persona: { model: "test", maxScenes: 5, sceneBackupCount: 1 },
    } as unknown as MemoryTdaiConfig;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const runner = createL2Runner({
      pluginDataDir: dataDir,
      cfg,
      openclawConfig: undefined,
      vectorStore: store,
      logger,
      llmRunner: {} as LLMRunner,
    });

    await runner("s");
    const actual = await checkpoint.read();
    expect(actual.total_processed).toBe(6);
    expect(actual.l0_conversations_count).toBe(6);
    expect(actual.total_memories_extracted).toBe(3);
    expect(actual.memories_since_last_persona).toBe(3);
    expect(actual.scenes_processed).toBe(3);
  });
});
