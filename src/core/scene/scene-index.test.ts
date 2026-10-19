import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSceneIndex } from "./scene-index.js";

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tdai-scene-index-"));
  tempDirs.push(dir);
  return dir;
}

describe("readSceneIndex", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("normalizes filenames loaded from metadata", async () => {
    const dataDir = await makeDataDir();
    const metadataDir = path.join(dataDir, ".metadata");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(
      path.join(metadataDir, "scene_index.json"),
      JSON.stringify([
        {
          filename: "../../secret.md",
          summary: "unsafe",
          heat: 1,
          created: "2026-07-02T00:00:00.000Z",
          updated: "2026-07-02T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );

    const entries = await readSceneIndex(dataDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe("secret.md");
  });
});
