import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { countL1JsonlLines, countL1JsonlLinesSince } from "./l1-reader.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-l1-stats-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("L1 JSONL checkpoint counters", () => {
  it("counts parseable records across dated shard files", async () => {
    const dir = await makeTempDir();
    const recordsDir = path.join(dir, "records");
    await mkdir(recordsDir, { recursive: true });
    await writeFile(
      path.join(recordsDir, "2026-06-01.jsonl"),
      [
        JSON.stringify({ id: "old", updatedAt: "2026-06-01T10:00:00.000Z" }),
        JSON.stringify({ id: "boundary", updatedAt: "2026-06-01T12:00:00.000Z" }),
        "{bad-json",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(recordsDir, "2026-06-02.jsonl"),
      `${JSON.stringify({ id: "new", updatedAt: "2026-06-02T10:00:00.000Z" })}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(recordsDir, "scratch.jsonl"),
      `${JSON.stringify({ id: "ignored", updatedAt: "2026-06-03T10:00:00.000Z" })}\n`,
      "utf-8",
    );

    await expect(countL1JsonlLines(dir)).resolves.toBe(3);
    await expect(countL1JsonlLinesSince(dir, "2026-06-01T12:00:00.000Z")).resolves.toBe(1);
  });

  it("treats an empty persona timestamp as all surviving records", async () => {
    const dir = await makeTempDir();
    const recordsDir = path.join(dir, "records");
    await mkdir(recordsDir, { recursive: true });
    await writeFile(
      path.join(recordsDir, "2026-06-01.jsonl"),
      [
        JSON.stringify({ id: "a", updatedAt: "2026-06-01T10:00:00.000Z" }),
        JSON.stringify({ id: "b", updatedAt: "2026-06-01T11:00:00.000Z" }),
      ].join("\n"),
      "utf-8",
    );

    await expect(countL1JsonlLinesSince(dir, "")).resolves.toBe(2);
  });
});
