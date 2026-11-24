import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalMemoryCleaner } from "./memory-cleaner.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const cleanupDirs: string[] = [];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function shardName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
}

async function createBaseDir(days: Date[]): Promise<string> {
  const baseDir = await mkdtemp(join(tmpdir(), "memory-cleaner-"));
  cleanupDirs.push(baseDir);
  const conversations = join(baseDir, "conversations");
  await mkdir(conversations, { recursive: true });
  for (const day of days) {
    await writeFile(join(conversations, shardName(day)), "{}\n");
  }
  return baseDir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("LocalMemoryCleaner retention window", () => {
  const now = new Date(2026, 10, 9, 12, 0, 0); // local noon, 2026-11-09
  const today = new Date(now);
  const yesterday = new Date(now.getTime() - DAY_MS);
  const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);
  const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);

  it("cleans expired shards when retentionDays is 1 (keep today only)", async () => {
    const baseDir = await createBaseDir([today, yesterday, twoDaysAgo]);
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 1,
      cleanTime: "03:00",
    });

    await cleaner.runOnce(now.getTime());

    expect(await exists(join(baseDir, "conversations", shardName(today)))).toBe(true);
    expect(await exists(join(baseDir, "conversations", shardName(yesterday)))).toBe(false);
    expect(await exists(join(baseDir, "conversations", shardName(twoDaysAgo)))).toBe(false);
  });

  it("keeps the last two local days when retentionDays is 2", async () => {
    const baseDir = await createBaseDir([today, yesterday, twoDaysAgo]);
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
    });

    await cleaner.runOnce(now.getTime());

    expect(await exists(join(baseDir, "conversations", shardName(today)))).toBe(true);
    expect(await exists(join(baseDir, "conversations", shardName(yesterday)))).toBe(true);
    expect(await exists(join(baseDir, "conversations", shardName(twoDaysAgo)))).toBe(false);
  });

  it("keeps the configured number of local days for retentionDays >= 3", async () => {
    const baseDir = await createBaseDir([today, yesterday, twoDaysAgo, threeDaysAgo]);
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 3,
      cleanTime: "03:00",
    });

    await cleaner.runOnce(now.getTime());

    expect(await exists(join(baseDir, "conversations", shardName(today)))).toBe(true);
    expect(await exists(join(baseDir, "conversations", shardName(yesterday)))).toBe(true);
    expect(await exists(join(baseDir, "conversations", shardName(twoDaysAgo)))).toBe(true);
    expect(await exists(join(baseDir, "conversations", shardName(threeDaysAgo)))).toBe(false);
  });
});
