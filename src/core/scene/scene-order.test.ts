import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readSceneIndex,
  type SceneIndexEntry,
  writeSceneIndex,
} from "./scene-index.js";
import { generateSceneNavigation } from "./scene-navigation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function scene(filename: string, heat: number): SceneIndexEntry {
  return {
    filename,
    summary: `Summary for ${filename}`,
    heat,
    created: "2026-07-01",
    updated: "2026-07-10",
  };
}

describe("stable scene ordering", () => {
  it("renders identical navigation for permutations with equal heat", () => {
    const first = [scene("beta.md", 10), scene("hot.md", 20), scene("alpha.md", 10)];
    const second = [first[2], first[0], first[1]];

    const firstNavigation = generateSceneNavigation(first);
    const secondNavigation = generateSceneNavigation(second);

    expect(secondNavigation).toBe(firstNavigation);
    expect(firstNavigation.indexOf("hot.md")).toBeLessThan(firstNavigation.indexOf("alpha.md"));
    expect(firstNavigation.indexOf("alpha.md")).toBeLessThan(firstNavigation.indexOf("beta.md"));
    expect(first.map((entry) => entry.filename)).toEqual(["beta.md", "hot.md", "alpha.md"]);
  });

  it("canonicalizes scene index persistence and reads", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tdai-scene-order-"));
    temporaryDirectories.push(dataDir);

    await writeSceneIndex(dataDir, [
      scene("beta.md", 10),
      scene("cold.md", 1),
      scene("alpha.md", 10),
      scene("hot.md", 20),
    ]);

    const entries = await readSceneIndex(dataDir);
    expect(entries.map((entry) => entry.filename)).toEqual([
      "hot.md",
      "alpha.md",
      "beta.md",
      "cold.md",
    ]);

    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, ".metadata", "scene_index.json"), "utf-8"),
    ) as SceneIndexEntry[];
    expect(persisted.map((entry) => entry.filename)).toEqual(
      entries.map((entry) => entry.filename),
    );
  });
});
