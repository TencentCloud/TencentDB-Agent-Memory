/**
 * Tests for CheckpointManager.recalibrate() — issue #157.
 *
 * Verifies that aggregate counters (`total_memories_extracted`,
 * `l0_conversations_count`) can be re-aligned with authoritative storage
 * after external cleanup leaves them drifted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CheckpointManager } from "./checkpoint.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-recalibrate-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Read the checkpoint file directly to assert on-disk state. */
async function readCheckpointFile(): Promise<Record<string, unknown>> {
  const file = path.join(dataDir, ".metadata", "recall_checkpoint.json");
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("CheckpointManager.recalibrate() — issue #157", () => {
  it("drifts counters up via markL1ExtractionComplete and captureAtomically", async () => {
    const cm = new CheckpointManager(dataDir);
    // Drift the counters to non-zero values
    await cm.markL1ExtractionComplete("session-a", 50);
    await cm.markL1ExtractionComplete("session-b", 30);
    await cm.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 1000,
      messageCount: 4,
    }));
    await cm.captureAtomically("session-b", undefined, async () => ({
      maxTimestamp: 2000,
      messageCount: 6,
    }));

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(80);
    expect(cp.l0_conversations_count).toBe(2);
  });

  it("recalibrate overwrites both counters when both drift", async () => {
    const cm = new CheckpointManager(dataDir);
    await cm.markL1ExtractionComplete("session-a", 50);
    await cm.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 1000,
      messageCount: 4,
    }));
    await cm.captureAtomically("session-b", undefined, async () => ({
      maxTimestamp: 2000,
      messageCount: 6,
    }));

    // Simulate external cleanup: real data is 42 L1 + 3 L0, checkpoint says 50/2
    const report = await cm.recalibrate({ l1Memories: 42, l0Conversations: 3 });

    expect(report.totalMemoriesExtracted.old).toBe(50);
    expect(report.totalMemoriesExtracted.new).toBe(42);
    expect(report.totalMemoriesExtracted.changed).toBe(true);
    expect(report.l0ConversationsCount.old).toBe(2);
    expect(report.l0ConversationsCount.new).toBe(3);
    expect(report.l0ConversationsCount.changed).toBe(true);

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(3);
  });

  it("recalibrate to a HIGHER value works (e.g. backup restored)", async () => {
    // Real-world: a backup restore could make authoritative count larger
    // than the in-memory counter. recalibrate must accept that too.
    const cm = new CheckpointManager(dataDir);
    await cm.markL1ExtractionComplete("session-a", 10);

    const report = await cm.recalibrate({ l1Memories: 100, l0Conversations: 5 });
    expect(report.totalMemoriesExtracted.changed).toBe(true);
    expect(report.l0ConversationsCount.changed).toBe(true);

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(100);
    expect(cp.l0_conversations_count).toBe(5);
  });

  it("recalibrate leaves a counter untouched when undefined is passed", async () => {
    const cm = new CheckpointManager(dataDir);
    await cm.markL1ExtractionComplete("session-a", 25);
    await cm.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 1000,
      messageCount: 2,
    }));

    // Only fix L1; leave L0 alone.
    const report = await cm.recalibrate({ l1Memories: 7 });

    expect(report.totalMemoriesExtracted.old).toBe(25);
    expect(report.totalMemoriesExtracted.new).toBe(7);
    expect(report.totalMemoriesExtracted.changed).toBe(true);
    expect(report.l0ConversationsCount.old).toBe(1);
    expect(report.l0ConversationsCount.new).toBe(1);
    expect(report.l0ConversationsCount.changed).toBe(false);

    const cp = await cm.read();
    expect(cp.l0_conversations_count).toBe(1);
  });

  it("recalibrate is a no-op when called with empty input", async () => {
    const cm = new CheckpointManager(dataDir);
    await cm.markL1ExtractionComplete("session-a", 11);

    const report = await cm.recalibrate({});
    expect(report.totalMemoriesExtracted.changed).toBe(false);
    expect(report.l0ConversationsCount.changed).toBe(false);

    const cp = await cm.read();
    expect(cp.total_memories_extracted).toBe(11);
    expect(cp.l0_conversations_count).toBe(0);
  });

  it("recalibrate creates a fresh checkpoint when none exists", async () => {
    const cm = new CheckpointManager(dataDir);
    // Don't write anything first; the file shouldn't exist yet.
    await expect(fs.access(path.join(dataDir, ".metadata", "recall_checkpoint.json")))
      .rejects.toThrow();

    const report = await cm.recalibrate({ l1Memories: 5, l0Conversations: 2 });
    expect(report.totalMemoriesExtracted.old).toBe(0);
    expect(report.totalMemoriesExtracted.new).toBe(5);
    expect(report.l0ConversationsCount.old).toBe(0);
    expect(report.l0ConversationsCount.new).toBe(2);

    // File must now exist on disk
    const onDisk = await readCheckpointFile();
    expect(onDisk.total_memories_extracted).toBe(5);
    expect(onDisk.l0_conversations_count).toBe(2);
  });

  it("recalibrate persists across new CheckpointManager instances", async () => {
    const cm1 = new CheckpointManager(dataDir);
    await cm1.markL1ExtractionComplete("session-a", 99);

    await cm1.recalibrate({ l1Memories: 7, l0Conversations: 3 });

    // A fresh instance reads the recalibrated values, not the drifted ones.
    const cm2 = new CheckpointManager(dataDir);
    const cp = await cm2.read();
    expect(cp.total_memories_extracted).toBe(7);
    expect(cp.l0_conversations_count).toBe(3);
  });

  it("recalibrate preserves other checkpoint fields (persona state, per-session state)", async () => {
    const cm = new CheckpointManager(dataDir);
    await cm.markL1ExtractionComplete("session-a", 50);
    await cm.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 5000,
      messageCount: 3,
    }));
    await cm.markPersonaGenerated(50);

    await cm.recalibrate({ l1Memories: 10, l0Conversations: 1 });

    const cp = await cm.read();
    // Counters are recalibrated
    expect(cp.total_memories_extracted).toBe(10);
    expect(cp.l0_conversations_count).toBe(1);
    // Persona fields untouched
    expect(cp.last_persona_at).toBe(50);
    expect(cp.memories_since_last_persona).toBe(0);
    // Per-session state preserved (last_captured_timestamp set by capture)
    const rs = cp.runner_states["session-a"];
    expect(rs).toBeDefined();
    expect(rs.last_captured_timestamp).toBe(5000);
  });

  it("recalibrate rejects negative or non-finite inputs", async () => {
    const cm = new CheckpointManager(dataDir);
    await expect(cm.recalibrate({ l1Memories: -1 })).rejects.toThrow(TypeError);
    await expect(cm.recalibrate({ l0Conversations: -1 })).rejects.toThrow(TypeError);
    await expect(cm.recalibrate({ l1Memories: Number.NaN })).rejects.toThrow(TypeError);
    await expect(cm.recalibrate({ l0Conversations: Number.POSITIVE_INFINITY })).rejects.toThrow(TypeError);
  });

  it("recalibrate is atomic under concurrent mutate calls (no torn writes)", async () => {
    // Race: two concurrent mutates must not interleave. The file lock
    // serializes them so the final state matches one of the two writes.
    const cm = new CheckpointManager(dataDir);
    await cm.markL1ExtractionComplete("session-a", 100);

    const results = await Promise.all([
      cm.recalibrate({ l1Memories: 10 }),
      cm.recalibrate({ l1Memories: 20 }),
      cm.recalibrate({ l1Memories: 30 }),
    ]);

    // One of the three values must have won; nothing in between.
    const finalValues = results.map((r) => r.totalMemoriesExtracted.new).sort();
    expect(finalValues).toEqual([10, 20, 30]);

    const cp = await cm.read();
    expect([10, 20, 30]).toContain(cp.total_memories_extracted);

    // No torn write: file is valid JSON with the winning value.
    const onDisk = await readCheckpointFile();
    expect([10, 20, 30]).toContain(onDisk.total_memories_extracted);
  });
});
