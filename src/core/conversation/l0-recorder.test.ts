import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { countL0JsonlStats } from "./l0-recorder.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-l0-stats-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("countL0JsonlStats", () => {
  it("counts parseable message rows and distinct capture batches", async () => {
    const dir = await makeTempDir();
    const conversationsDir = path.join(dir, "conversations");
    await mkdir(conversationsDir, { recursive: true });
    await writeFile(
      path.join(conversationsDir, "2026-06-01.jsonl"),
      [
        JSON.stringify({ id: "a", recordedAt: "2026-06-01T10:00:00.000Z" }),
        JSON.stringify({ id: "b", recordedAt: "2026-06-01T10:00:00.000Z" }),
        JSON.stringify({ id: "c", recordedAt: "2026-06-01T11:00:00.000Z" }),
        JSON.stringify({ id: "d" }),
        "{not-json",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(conversationsDir, "notes.jsonl"),
      JSON.stringify({ id: "ignored", recordedAt: "2026-06-01T12:00:00.000Z" }),
      "utf-8",
    );

    await expect(countL0JsonlStats(dir)).resolves.toEqual({ messages: 4, captures: 2 });
  });

  it("returns zeros when the conversations directory is missing", async () => {
    const dir = await makeTempDir();
    await expect(countL0JsonlStats(dir)).resolves.toEqual({ messages: 0, captures: 0 });
  });
});
