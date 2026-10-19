import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { _resetTimeModuleForTest, initTimeModule } from "./time.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeShard(baseDir: string, dirName: string, fileName: string): Promise<string> {
  const dir = path.join(baseDir, dirName);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, "{}\n", "utf-8");
  return filePath;
}

afterEach(async () => {
  _resetTimeModuleForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LocalMemoryCleaner", () => {
  it("allows one-day retention to delete shards before local today", async () => {
    initTimeModule({ timezone: "UTC" });
    const baseDir = await makeTempDir("memory-cleaner-");

    const oldConversationShard = await writeShard(baseDir, "conversations", "2026-06-29.jsonl");
    const todayConversationShard = await writeShard(baseDir, "conversations", "2026-06-30.jsonl");
    const oldRecordShard = await writeShard(baseDir, "records", "2026-06-29.jsonl");
    const todayRecordShard = await writeShard(baseDir, "records", "2026-06-30.jsonl");

    const errors: string[] = [];
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 1,
      cleanTime: "03:00",
      logger: {
        info: () => {},
        warn: () => {},
        error: (msg) => errors.push(msg),
      },
    });

    await cleaner.runOnce(Date.parse("2026-06-30T12:00:00.000Z"));

    expect(errors).toEqual([]);
    expect(await exists(oldConversationShard)).toBe(false);
    expect(await exists(oldRecordShard)).toBe(false);
    expect(await exists(todayConversationShard)).toBe(true);
    expect(await exists(todayRecordShard)).toBe(true);
  });
});
