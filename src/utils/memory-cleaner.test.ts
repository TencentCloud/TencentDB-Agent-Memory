/**
 * Integration tests for LocalMemoryCleaner counter reconciliation (#157).
 *
 * Verifies that after `runOnce()` cleans up expired records, the checkpoint
 * counters are recalculated against authoritative sources (vectorStore counts
 * + scene_blocks file count) so they no longer drift from actual data.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { CheckpointManager } from "./checkpoint.js";
import type { IMemoryStore, StoreInitResult, StoreCapabilities, L0Record, MemoryRecord, L1RecordRow, L0QueryRow, L0SessionGroup, L1SearchResult, L0SearchResult, L1FtsResult, EmbeddingProviderInfo } from "../core/store/types.js";

// ============================
// Fake vector store for testing
// ============================

/**
 * Minimal in-memory IMemoryStore that only implements the methods the cleaner
 * and tests touch: countL0, countL1, deleteL0Expired, deleteL1Expired.
 * All other IMemoryStore methods throw "not implemented" so we don't accidentally
 * rely on defaults that might mask test failures.
 */
class FakeVectorStore implements IMemoryStore {
  private l0Count = 0;
  private l1Count = 0;

  constructor(opts: { l0Count: number; l1Count: number }) {
    this.l0Count = opts.l0Count;
    this.l1Count = opts.l1Count;
  }

  // ── Capabilities ──
  readonly supportsDeferredEmbedding?: boolean;
  init(_providerInfo?: EmbeddingProviderInfo): MaybePromise<StoreInitResult> {
    throw new Error("not implemented");
  }
  isDegraded(): boolean { return false; }
  getCapabilities(): StoreCapabilities {
    throw new Error("not implemented");
  }
  close(): void { /* noop */ }

  // ── L1 Write ──
  upsertL1(_record: MemoryRecord, _embedding?: Float32Array): MaybePromise<boolean> {
    throw new Error("not implemented");
  }
  deleteL1(_recordId: string): MaybePromise<boolean> {
    throw new Error("not implemented");
  }
  deleteL1Batch(_recordIds: string[]): MaybePromise<boolean> {
    throw new Error("not implemented");
  }
  deleteL1Expired(_cutoffIso: string): MaybePromise<number> {
    // Simulate deleting half of L1 records (the "expired" ones)
    const removed = Math.floor(this.l1Count / 2);
    this.l1Count -= removed;
    return removed;
  }

  // ── L1 Read ──
  countL1(): MaybePromise<number> { return this.l1Count; }
  queryL1Records(_filter?: unknown): MaybePromise<L1RecordRow[]> {
    throw new Error("not implemented");
  }
  getAllL1Texts(): MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>> {
    throw new Error("not implemented");
  }

  // ── L1 Search ──
  searchL1Vector(_queryEmbedding: Float32Array, _topK?: number, _queryText?: string): MaybePromise<L1SearchResult[]> {
    throw new Error("not implemented");
  }
  searchL1Fts(_ftsQuery: string, _limit?: number): MaybePromise<L1FtsResult[]> {
    throw new Error("not implemented");
  }

  // ── L0 Write ──
  upsertL0(_record: L0Record, _embedding?: Float32Array): MaybePromise<boolean> {
    throw new Error("not implemented");
  }
  updateL0Embedding?(_recordId: string, _embedding: Float32Array): MaybePromise<boolean> {
    throw new Error("not implemented");
  }
  deleteL0(_recordId: string): MaybePromise<boolean> {
    throw new Error("not implemented");
  }
  deleteL0Expired(_cutoffIso: string): MaybePromise<number> {
    const removed = Math.floor(this.l0Count / 2);
    this.l0Count -= removed;
    return removed;
  }

  // ── L0 Read ──
  countL0(): MaybePromise<number> { return this.l0Count; }
  queryL0ForL1(_sessionKey: string, _afterRecordedAtMs?: number, _limit?: number): MaybePromise<L0QueryRow[]> {
    throw new Error("not implemented");
  }
  queryL0GroupedBySessionId(_sessionKey: string, _afterRecordedAtMs?: number, _limit?: number): MaybePromise<L0SessionGroup[]> {
    throw new Error("not implemented");
  }
  getAllL0Texts(): MaybePromise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    throw new Error("not implemented");
  }

  // ── L0 Search ──
  searchL0Vector(_queryEmbedding: Float32Array, _topK?: number, _queryText?: string): MaybePromise<L0SearchResult[]> {
    throw new Error("not implemented");
  }
  searchL0Fts(_ftsQuery: string, _limit?: number): MaybePromise<L0SearchResult[]> {
    throw new Error("not implemented");
  }

  pullProfiles?(): Promise<import("../core/store/types.js").ProfileRecord[]> {
    throw new Error("not implemented");
  }
  syncProfiles?(_records: import("../core/store/types.js").ProfileSyncRecord[]): Promise<void> {
    throw new Error("not implemented");
  }
  deleteProfiles?(_recordIds: string[]): Promise<void> {
    throw new Error("not implemented");
  }

  reindexAll(
    _embedFn: (text: string) => Promise<Float32Array>,
    _onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    throw new Error("not implemented");
  }
}

// Need MaybePromise type import
import type { MaybePromise } from "../core/store/types.js";

// ============================
// Test harness
// ============================

async function makeTempBaseDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cleaner-test-"));
}

async function cleanupDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Create scene_blocks/*.md files under baseDir to test scenes_processed reconciliation.
 */
async function writeSceneBlocks(baseDir: string, count: number): Promise<void> {
  const blocksDir = path.join(baseDir, "scene_blocks");
  await fs.mkdir(blocksDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    await fs.writeFile(path.join(blocksDir, `scene-${i}.md`), `# Scene ${i}\n`);
  }
}

describe("LocalMemoryCleaner — counter reconciliation (#157)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await makeTempBaseDir();
  });

  afterEach(async () => {
    await cleanupDir(baseDir);
  });

  it("recalculates counters after cleanup using vectorStore counts + scene files", async () => {
    // Pre-state: checkpoint thinks there are 100 L0, 200 L1, 5 scenes (drifted high)
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.captureAtomically("sess-a", 0, async () => ({
      maxTimestamp: 1000,
      messageCount: 100,
    }));
    await checkpoint.markL1ExtractionComplete("sess-a", 200);
    for (let i = 0; i < 5; i++) await checkpoint.incrementScenesProcessed();

    // Reality: vector store has 60 L0, 120 L1 (after half deleted); fs has 3 scene files
    const fakeStore = new FakeVectorStore({ l0Count: 60, l1Count: 120 });
    await writeSceneBlocks(baseDir, 3);

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: fakeStore,
      checkpointManager: checkpoint,
    });

    await cleaner.runOnce();

    const cp = await checkpoint.read();
    // Counters recalculated to authoritative values (after deleteL0Expired/deleteL1Expired halved counts)
    // FakeVectorStore starts at 60/120, deleteL*Expired removes half → 30/60 remain
    expect(cp.total_processed).toBe(30);
    expect(cp.total_memories_extracted).toBe(60);
    expect(cp.scenes_processed).toBe(3);
  });

  it("skips reconciliation when checkpointManager is not provided (legacy behavior)", async () => {
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.markL1ExtractionComplete("sess-a", 50);

    const fakeStore = new FakeVectorStore({ l0Count: 10, l1Count: 20 });
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: fakeStore,
      // checkpointManager intentionally omitted
    });

    await cleaner.runOnce();

    // Counters unchanged — no reconciliation
    const cp = await checkpoint.read();
    expect(cp.total_memories_extracted).toBe(50);
  });

  it("reconciles scenes_processed from fs even without vectorStore", async () => {
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.incrementScenesProcessed();
    await checkpoint.incrementScenesProcessed();
    await checkpoint.incrementScenesProcessed();
    await checkpoint.incrementScenesProcessed();
    // Checkpoint thinks 4 scenes; fs has 2
    await writeSceneBlocks(baseDir, 2);

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      // vectorStore intentionally omitted
      checkpointManager: checkpoint,
    });

    await cleaner.runOnce();

    const cp = await checkpoint.read();
    // scenes_processed recalculated from fs (2); total_processed/memories default to 0 (no store)
    expect(cp.scenes_processed).toBe(2);
    expect(cp.total_processed).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
  });

  it("setCheckpointManager allows late wiring after construction", async () => {
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.markL1ExtractionComplete("sess-a", 100);

    // Use counts above MIN_RETAIN thresholds (L0>50, L1>20) so deletion actually runs
    const fakeStore = new FakeVectorStore({ l0Count: 60, l1Count: 30 });
    await writeSceneBlocks(baseDir, 1);

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: fakeStore,
      // checkpointManager not passed in constructor
    });

    // Late-wire checkpoint (mirrors setVectorStore pattern)
    cleaner.setCheckpointManager(checkpoint);

    await cleaner.runOnce();

    const cp = await checkpoint.read();
    // 30 → deleteL1Expired halves → 15; 60 → deleteL0Expired halves → 30
    expect(cp.total_memories_extracted).toBe(15);
    expect(cp.total_processed).toBe(30);
    expect(cp.scenes_processed).toBe(1);
  });
});
