import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointManager,
  reconcileCheckpointFromStore,
} from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import type { IMemoryStore } from "../core/store/types.js";

const tempDirs: string[] = [];

async function createCheckpointManager(): Promise<CheckpointManager> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dataDir);
  return new CheckpointManager(dataDir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager counter reconciliation", () => {
  it("uses the cold-start timestamp once, then reuses the saved cursor", async () => {
    const manager = await createCheckpointManager();

    let firstCursor: number | undefined;
    await manager.captureAtomically("practice-session", 100, async (cursor) => {
      firstCursor = cursor;
      return { maxTimestamp: 250, messageCount: 1 };
    });

    let secondCursor: number | undefined;
    await manager.captureAtomically("practice-session", 100, async (cursor) => {
      secondCursor = cursor;
      return null;
    });

    expect(firstCursor).toBe(100);
    expect(secondCursor).toBe(250);
  });

  it("increments L1 counters and saves the L1 cursor", async () => {
    const manager = await createCheckpointManager();

    await manager.markL1ExtractionComplete("practice-session", 3, 250);

    expect(await manager.read()).toMatchObject({
      total_memories_extracted: 3,
      memories_since_last_persona: 3,
      runner_states: {
        "practice-session": { last_l1_cursor: 250 },
      },
    });
  });


  it("counts every message in a captured L0 batch", async () => {
    const manager = await createCheckpointManager();

    await manager.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 1000,
      messageCount: 2,
    }));

    expect(await manager.read()).toMatchObject({
      total_processed: 2,
      l0_conversations_count: 2,
      runner_states: {
        "session-a": { last_captured_timestamp: 1000 },
      },
    });
  });

  it("repairs drifted aggregates without rewriting processing cursors", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();

    await manager.write({
      ...initial,
      total_processed: 100,
      l0_conversations_count: 40,
      total_memories_extracted: 80,
      memories_since_last_persona: 30,
      runner_states: {
        "session-a": {
          last_captured_timestamp: 1000,
          last_l1_cursor: 900,
          last_scene_name: "project",
        },
      },
      pipeline_states: {
        "session-a": {
          conversation_count: 3,
          last_extraction_time: "2026-07-24T00:00:00.000Z",
          last_extraction_updated_time: "2026-07-24T00:00:00.000Z",
          last_active_time: 1000,
          l2_pending_l1_count: 2,
          warmup_threshold: 4,
          l2_last_extraction_time: "2026-07-24T00:00:00.000Z",
        },
      },
    });

    await manager.reconcileCounters({
      l0Conversations: 3,
      totalMemoriesExtracted: 4,
      memoriesSinceLastPersona: 1,
    });

    const repaired = await manager.read();
    expect(repaired).toMatchObject({
      total_processed: 100,
      l0_conversations_count: 3,
      total_memories_extracted: 4,
      memories_since_last_persona: 1,
      runner_states: {
        "session-a": {
          last_captured_timestamp: 1000,
          last_l1_cursor: 900,
          last_scene_name: "project",
        },
      },
      pipeline_states: {
        "session-a": {
          conversation_count: 3,
          warmup_threshold: 4,
        },
      },
    });
  });

  it("rebuilds aggregate counters from durable store records", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 100,
      l0_conversations_count: 40,
      total_memories_extracted: 80,
      memories_since_last_persona: 30,
      last_persona_time: "2026-07-20T00:00:00.000Z",
    });
    const requestedFilters: Array<{ updatedAfter?: string } | undefined> = [];
    const store = {
      countL0: () => 6,
      countL1: () => 4,
      queryL1Records: (filter?: { updatedAfter?: string }) => {
        requestedFilters.push(filter);
        return [
          { updated_time: "2026-07-21T00:00:00.000Z" },
          { updated_time: "2026-07-22T00:00:00.000Z" },
        ];
      },
    };

    await reconcileCheckpointFromStore(manager, store);

    expect(requestedFilters).toEqual([
      { updatedAfter: "2026-07-20T00:00:00.000Z" },
    ]);
    expect(await manager.read()).toMatchObject({
      total_processed: 100,
      l0_conversations_count: 6,
      total_memories_extracted: 4,
      memories_since_last_persona: 2,
    });
  });

  it("uses all active L1 records as the Persona baseline when none exists", async () => {
    const manager = await createCheckpointManager();
    let queriedL1Records = false;
    const store = {
      countL0: () => 3,
      countL1: () => 2,
      queryL1Records: () => {
        queriedL1Records = true;
        return [];
      },
    };

    await reconcileCheckpointFromStore(manager, store);

    expect(queriedL1Records).toBe(false);
    expect(await manager.read()).toMatchObject({
      total_processed: 0,
      l0_conversations_count: 3,
      total_memories_extracted: 2,
      memories_since_last_persona: 2,
    });
  });

  it("leaves the checkpoint unchanged when the Store cannot provide a count", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 9,
      l0_conversations_count: 9,
      total_memories_extracted: 5,
      memories_since_last_persona: 3,
    });
    const before = await manager.read();
    const store = {
      countL0: () => {
        throw new Error("database unavailable");
      },
      countL1: () => 2,
      queryL1Records: () => [],
    };

    await expect(reconcileCheckpointFromStore(manager, store)).rejects.toThrow(
      "Checkpoint reconciliation countL0() failed: database unavailable",
    );
    expect(await manager.read()).toEqual(before);
  });

  it("skips a degraded Store without clearing counters", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();
    await manager.write({
      ...initial,
      l0_conversations_count: 9,
      total_memories_extracted: 5,
      memories_since_last_persona: 3,
    });
    const before = await manager.read();
    const store = {
      isDegraded: () => true,
      countL0: () => 0,
      countL1: () => 0,
      queryL1Records: () => [],
    };

    await expect(reconcileCheckpointFromStore(manager, store)).rejects.toThrow(
      "Checkpoint reconciliation skipped: Store is degraded",
    );
    expect(await manager.read()).toEqual(before);
  });

  it("reports the failing Store operation without changing the checkpoint", async () => {
    const manager = await createCheckpointManager();
    const store = {
      countL0: () => 1,
      countL1: () => 1,
      queryL1Records: () => {
        throw new Error("query unavailable");
      },
    };

    await manager.markPersonaGenerated(0);
    const before = await manager.read();

    await expect(reconcileCheckpointFromStore(manager, store)).rejects.toThrow(
      "Checkpoint reconciliation queryL1Records(updatedAfter=",
    );
    expect(await manager.read()).toEqual(before);
  });

  it("does not overwrite a capture that starts while reconciliation is counting", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 6,
      l0_conversations_count: 6,
      total_memories_extracted: 2,
      memories_since_last_persona: 2,
    });

    let signalCountStarted!: () => void;
    let releaseCount!: () => void;
    const countStarted = new Promise<void>((resolve) => {
      signalCountStarted = resolve;
    });
    const countReleased = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });
    const store = {
      countL0: async () => {
        signalCountStarted();
        await countReleased;
        return 6;
      },
      countL1: () => 2,
      queryL1Records: () => [],
    };

    const reconciliation = reconcileCheckpointFromStore(manager, store);
    await countStarted;

    let captureCallbackRan = false;
    const capture = manager.captureAtomically("session-a", undefined, async () => {
      captureCallbackRan = true;
      return { maxTimestamp: 1000, messageCount: 1 };
    });

    await Promise.resolve();
    expect(captureCallbackRan).toBe(false);

    releaseCount();
    await Promise.all([reconciliation, capture]);

    expect(await manager.read()).toMatchObject({
      total_processed: 7,
      l0_conversations_count: 7,
      total_memories_extracted: 2,
    });
  });

  it("reconciles counters immediately after Cleaner deletes Store records", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
    tempDirs.push(dataDir);
    const manager = new CheckpointManager(dataDir);
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 100,
      l0_conversations_count: 100,
      total_memories_extracted: 40,
      memories_since_last_persona: 20,
      last_persona_time: "2026-07-20T00:00:00.000Z",
    });

    let l0Count = 52;
    let l1Count = 22;
    const store = {
      isDegraded: () => false,
      countL0: () => l0Count,
      countL1: () => l1Count,
      deleteL0Expired: () => {
        l0Count -= 2;
        return 2;
      },
      deleteL1Expired: () => {
        l1Count -= 2;
        return 2;
      },
      queryL1Records: () => [
        { updated_time: "2026-07-21T00:00:00.000Z" },
      ],
    } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: store,
    });

    await cleaner.runOnce(new Date("2026-07-24T12:00:00.000Z").getTime());

    expect(await manager.read()).toMatchObject({
      total_processed: 100,
      l0_conversations_count: 50,
      total_memories_extracted: 20,
      memories_since_last_persona: 1,
    });
  });

  it("does not change counters when Cleaner retains every Store record", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
    tempDirs.push(dataDir);
    const manager = new CheckpointManager(dataDir);
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 50,
      l0_conversations_count: 50,
      total_memories_extracted: 20,
      memories_since_last_persona: 7,
    });
    const before = await manager.read();
    const store = {
      isDegraded: () => false,
      countL0: () => 50,
      countL1: () => 20,
      deleteL0Expired: () => 0,
      deleteL1Expired: () => 0,
      queryL1Records: () => [],
    } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: store,
    });

    await cleaner.runOnce(new Date("2026-07-24T12:00:00.000Z").getTime());

    expect(await manager.read()).toEqual(before);
  });
});
