import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager.recalibrate", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tencentdb-checkpoint-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("replaces stale counters with JSONL records and the current L0 store total", async () => {
    const recordsDir = path.join(dataDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-18.jsonl"),
      '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n',
    );
    await fs.writeFile(
      path.join(recordsDir, "2026-07-17.jsonl"),
      '{"id":"d"}\n\n{"id":"e"}\n',
    );

    const checkpoint = new CheckpointManager(dataDir);
    const stale = await checkpoint.read();
    await checkpoint.write({
      ...stale,
      l0_conversations_count: 92,
      total_memories_extracted: 47,
    });

    await checkpoint.recalibrate({
      countL0: async () => 12,
    });

    await expect(checkpoint.read()).resolves.toMatchObject({
      l0_conversations_count: 12,
      total_memories_extracted: 5,
    });
  });

  it("leaves the checkpoint unchanged when the L0 count fails", async () => {
    const checkpoint = new CheckpointManager(dataDir);
    const stale = await checkpoint.read();
    await checkpoint.write({
      ...stale,
      l0_conversations_count: 92,
      total_memories_extracted: 47,
    });

    await expect(
      checkpoint.recalibrate({
        countL0: async () => {
          throw new Error("store unavailable");
        },
      }),
    ).rejects.toThrow("store unavailable");

    await expect(checkpoint.read()).resolves.toMatchObject({
      l0_conversations_count: 92,
      total_memories_extracted: 47,
    });
  });
});
