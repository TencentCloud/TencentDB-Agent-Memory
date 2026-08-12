/**
 * L2 scene blocks are physically separated per project — one project's index,
 * blocks and navigation must never surface in another project.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncSceneIndex, readSceneIndex, readAllSceneIndexes } from "./scene-index.js";
import { generateSceneNavigation } from "./scene-navigation.js";
import { sceneBlocksDir, projectSlug, GLOBAL_SCENE_SLUG } from "./scene-paths.js";

const A = "/repo/alpha";
const B = "/repo/beta";

let dir: string;

function block(name: string): string {
  return [
    "-----META-START-----",
    `summary: ${name} summary`,
    "heat: 3",
    "created: 2026-07-01T00:00:00Z",
    "updated: 2026-07-02T00:00:00Z",
    "-----META-END-----",
    "",
    `# ${name}`,
    "",
    `${name} content`,
    "",
  ].join("\n");
}

async function writeBlock(projectId: string, filename: string): Promise<void> {
  const d = sceneBlocksDir(dir, projectId);
  await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(d, filename), block(filename.replace(/\.md$/, "")), "utf-8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-scene-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scene project separation", () => {
  it("keeps each project's index to its own blocks", async () => {
    await writeBlock(A, "alpha-deploy.md");
    await writeBlock(B, "beta-frontend.md");
    await syncSceneIndex(dir, A);
    await syncSceneIndex(dir, B);

    expect(await readSceneIndex(dir, A)).toEqual([
      { filename: "alpha-deploy.md", summary: "alpha-deploy summary", heat: 3, created: "2026-07-01T00:00:00Z", updated: "2026-07-02T00:00:00Z" },
    ]);
    expect((await readSceneIndex(dir, B)).map((e) => e.filename)).toEqual(["beta-frontend.md"]);
  });

  it("renders navigation paths inside the project directory", async () => {
    await writeBlock(A, "alpha-deploy.md");
    const nav = generateSceneNavigation(await syncSceneIndex(dir, A), dir, A);

    expect(nav).toContain(path.join(sceneBlocksDir(dir, A), "alpha-deploy.md"));
    expect(nav).not.toContain(projectSlug(B));
  });

  it("reads across projects only through readAllSceneIndexes (persona path)", async () => {
    await writeBlock(A, "alpha-deploy.md");
    await writeBlock(B, "beta-frontend.md");
    await syncSceneIndex(dir, A);
    await syncSceneIndex(dir, B);

    const all = await readAllSceneIndexes(dir);
    expect(all.map((p) => p.slug).sort()).toEqual([projectSlug(A), projectSlug(B)].sort());
    expect(all.flatMap((p) => p.entries).length).toBe(2);
  });

  it("does not read blocks left flat by the pre-scoping layout", async () => {
    await fsp.mkdir(path.join(dir, "scene_blocks"), { recursive: true });
    await fsp.writeFile(path.join(dir, "scene_blocks", "legacy.md"), block("legacy"), "utf-8");

    expect(await syncSceneIndex(dir, A)).toEqual([]);
    expect(await readAllSceneIndexes(dir)).toEqual([]);
  });
});

describe("projectSlug", () => {
  it("falls back to a fixed slug when there is no project", () => {
    expect(projectSlug("")).toBe(GLOBAL_SCENE_SLUG);
    expect(projectSlug(undefined)).toBe(GLOBAL_SCENE_SLUG);
  });

  it("keeps same-basename projects apart and stays filesystem-safe", () => {
    const one = projectSlug("/home/u/work/api");
    const two = projectSlug("/home/u/side/api");
    expect(one).not.toBe(two);
    expect(one.startsWith("api-")).toBe(true);
    expect(one).toMatch(/^[a-z0-9._-]+$/);
    expect(projectSlug("/tmp/Проект Мой")).toMatch(/^[a-z0-9._-]+$/);
  });
});
