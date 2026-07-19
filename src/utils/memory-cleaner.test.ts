import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import type { Logger } from "../core/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("LocalMemoryCleaner", () => {
  it("reconciles checkpoint counters after cleanup", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cleaner-"));
    tempDirs.push(baseDir);

    const recordsDir = path.join(baseDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(path.join(recordsDir, "2026-07-12.jsonl"), makeLines(3), "utf-8");
    await fs.writeFile(path.join(recordsDir, "2026-07-14.jsonl"), makeLines(22), "utf-8");

    const checkpoint = new CheckpointManager(baseDir, logger);
    const cp = await checkpoint.read();
    cp.l0_conversations_count = 60;
    cp.total_memories_extracted = 25;
    await checkpoint.write(cp);

    const vectorStore = {
      countL0: () => 60,
      countL1: () => 25,
      deleteL0Expired: () => 8,
      deleteL1Expired: () => 3,
    } as Partial<IMemoryStore> as IMemoryStore;

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
      vectorStore,
    });

    await cleaner.runOnce(new Date("2026-07-14T12:00:00Z").getTime());

    const updated = await checkpoint.read();
    expect(updated.l0_conversations_count).toBe(52);
    expect(updated.total_memories_extracted).toBe(22);
    await expect(fs.access(path.join(recordsDir, "2026-07-12.jsonl"))).rejects.toThrow();
  });
});

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ id: `m_${i}` })).join("\n") + "\n";
}
