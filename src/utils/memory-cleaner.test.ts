import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalMemoryCleaner } from "./memory-cleaner.js";
import type { CleanupStats } from "./memory-cleaner.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalMemoryCleaner post-cleanup hook", () => {
  it("calls onAfterCleanup when expired shards are removed", async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, "conversations"), { recursive: true });
    await mkdir(path.join(dir, "records"), { recursive: true });
    await writeFile(path.join(dir, "conversations", "2026-01-01.jsonl"), "{}\n", "utf-8");
    await writeFile(path.join(dir, "records", "2026-01-01.jsonl"), "{}\n", "utf-8");

    const calls: CleanupStats[] = [];
    const cleaner = new LocalMemoryCleaner({
      baseDir: dir,
      retentionDays: 3,
      cleanTime: "03:00",
      onAfterCleanup: (stats) => {
        calls.push({ ...stats });
      },
    });

    await cleaner.runOnce(Date.parse("2026-01-10T12:00:00.000Z"));

    expect(calls).toHaveLength(1);
    expect(calls[0].changedFiles).toBe(2);
    expect(calls[0].deleteFailedFiles).toBe(0);
  });

  it("does not call onAfterCleanup when nothing changed", async () => {
    const dir = await makeTempDir();
    const calls: CleanupStats[] = [];
    const cleaner = new LocalMemoryCleaner({
      baseDir: dir,
      retentionDays: 3,
      cleanTime: "03:00",
      onAfterCleanup: (stats) => {
        calls.push({ ...stats });
      },
    });

    await cleaner.runOnce(Date.parse("2026-01-10T12:00:00.000Z"));

    expect(calls).toHaveLength(0);
  });
});
