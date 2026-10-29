import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncSceneIndex } from "./scene-index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scene-index-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("syncSceneIndex", () => {
  it("indexes uppercase .MD scene files", async () => {
    const dataDir = await makeTempDir();
    const blocksDir = path.join(dataDir, "scene_blocks");
    await mkdir(blocksDir, { recursive: true });
    await writeFile(
      path.join(blocksDir, "Upper.MD"),
      "-----META-START-----\nsummary: upper\n-----META-END-----\n\nContent\n",
      "utf-8",
    );

    const entries = await syncSceneIndex(dataDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.filename).toBe("Upper.MD");
    expect(entries[0]?.summary).toBe("upper");
  });
});
