import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonl(
  dataDir: string,
  subdir: "conversations" | "records",
  fileName: string,
  records: Array<Record<string, unknown>>,
): Promise<string> {
  const dir = path.join(dataDir, subdir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf-8",
  );
  return filePath;
}

function l0Message(id: string, recordedAt: string): Record<string, unknown> {
  return {
    sessionKey: "agent:test",
    sessionId: "session-1",
    recordedAt,
    id,
    role: "user",
    content: `message ${id}`,
    timestamp: Date.parse(recordedAt),
  };
}

function l1Memory(id: string): Record<string, unknown> {
  return { id, content: `memory ${id}` };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("LocalMemoryCleaner checkpoint reconciliation", () => {
  it("recalibrates L0/L1 counters after expired shards are removed", async () => {
    const dataDir = await makeTempDir();
    const oldL0 = await writeJsonl(
      dataDir,
      "conversations",
      "2026-07-20.jsonl",
      [
        l0Message("old-1", "2026-07-20T08:00:00.000Z"),
        l0Message("old-2", "2026-07-20T09:00:00.000Z"),
      ],
    );
    const retainedL0 = await writeJsonl(
      dataDir,
      "conversations",
      "2026-07-31.jsonl",
      [l0Message("new-1", "2026-07-31T08:00:00.000Z")],
    );
    const oldL1 = await writeJsonl(dataDir, "records", "2026-07-20.jsonl", [
      l1Memory("old-1"),
      l1Memory("old-2"),
    ]);
    const retainedL1 = await writeJsonl(
      dataDir,
      "records",
      "2026-07-31.jsonl",
      [l1Memory("new-1")],
    );

    const checkpoint = new CheckpointManager(dataDir);
    const state = await checkpoint.read();
    state.l0_conversations_count = 3;
    state.total_memories_extracted = 3;
    await checkpoint.write(state);

    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
    });
    const nowMs = new Date(2026, 6, 31, 12, 0, 0, 0).getTime();

    await cleaner.runOnce(nowMs);

    const repaired = await checkpoint.read();
    expect(repaired.l0_conversations_count).toBe(1);
    expect(repaired.total_memories_extracted).toBe(1);
    await expect(fs.stat(oldL0)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(oldL1)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(retainedL0)).resolves.toBeDefined();
    await expect(fs.stat(retainedL1)).resolves.toBeDefined();
  });
});
