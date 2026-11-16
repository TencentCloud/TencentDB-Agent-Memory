import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeSceneFilenames } from "./filename-normalizer.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scene-filename-normalizer-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("normalizeSceneFilenames", () => {
  it("normalizes uppercase .MD files", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "Daily Rhythm.MD"), "# Daily", "utf-8");
    await writeFile(path.join(dir, "already-normalized.md"), "# Stable", "utf-8");
    await writeFile(path.join(dir, "notes.txt"), "ignored", "utf-8");

    const result = await normalizeSceneFilenames(dir);

    expect(result).toEqual({
      renamed: 1,
      skipped: 1,
      renames: [{ from: "Daily Rhythm.MD", to: "Daily-Rhythm.md" }],
    });
    expect((await readdir(dir)).sort()).toEqual([
      "Daily-Rhythm.md",
      "already-normalized.md",
      "notes.txt",
    ]);
  });
});
