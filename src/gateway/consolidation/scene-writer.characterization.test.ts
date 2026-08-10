/**
 * tz-02 Ф0 — what the scene/scratch path does TODAY, before the package.
 *
 * These are not aspirations. Each `it` pins a behaviour the package is about
 * to change, so the change shows up as a red line here and not as a surprise
 * somewhere downstream. Ф1/Ф2 are expected to break exactly the first two.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoleGate } from "./role-gate.js";
import { syncSceneIndex } from "../apply-executor/apply-route.js";
import { createL2Runner } from "../../utils/pipeline-factory/l2-runner.js";
import type { ApplyExecutorDeps } from "../apply-executor/apply-executor-deps.js";

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("tz-02 Ф0 characterization — scenes and scratch as they are", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz02-f0-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the single-flight key is the ROLE, so two roles enter together", () => {
    // The reason `single-scene-writer` is not a fact today: both roles carry
    // rewriteBlock, and nothing keyed by the RESOURCE stands between them.
    const gate = new RoleGate();
    const keeper = gate.tryAcquire("memory-keeper");
    const night = gate.tryAcquire("night-keeper");
    expect(keeper).not.toBeNull();
    expect(night).not.toBeNull();
    // Same role is what gets refused — the role, not the block.
    expect(gate.tryAcquire("memory-keeper")).toBeNull();
  });

  // Ф0 characterized the opposite: ANY apply rebuilt EVERY slug's index, so a
  // persona-only apply bumped the mtime of a project it never touched. Ф1
  // narrows the rebuild to the slugs the diff names, and this is the test that
  // now pins the new behaviour.
  it("a rebuild touches only the slugs it was given", async () => {
    const blocks = path.join(dir, "scene_blocks");
    for (const slug of ["project-a", "project-b"]) {
      fs.mkdirSync(path.join(blocks, slug), { recursive: true });
      fs.writeFileSync(
        path.join(blocks, slug, "scene-1.md"),
        `# scene\n\n${slug}\n`,
      );
    }
    const deps = {
      dataDir: dir,
      logger: silent,
    } as unknown as ApplyExecutorDeps;

    const both = new Set(["project-a", "project-b"]);
    expect(await syncSceneIndex(deps, both)).toBe(true);
    const indexB = path.join(dir, ".metadata", "scene_index", "project-b.json");
    const before = fs.statSync(indexB).mtimeMs;

    // Touch ONLY project-a, then sync ONLY project-a.
    fs.writeFileSync(
      path.join(blocks, "project-a", "scene-1.md"),
      "# scene\n\nchanged\n",
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(await syncSceneIndex(deps, new Set(["project-a"]))).toBe(true);

    expect(fs.statSync(indexB).mtimeMs).toBe(before);
    const indexA = path.join(dir, ".metadata", "scene_index", "project-a.json");
    expect(fs.readFileSync(indexA, "utf-8")).toContain("scene-1.md");
  });

  // An empty set is "nothing to rebuild", never "rebuild everything" — a
  // persona-only apply must not touch a single index.
  it("an empty slug set rebuilds nothing", async () => {
    const blocks = path.join(dir, "scene_blocks");
    fs.mkdirSync(path.join(blocks, "project-a"), { recursive: true });
    fs.writeFileSync(
      path.join(blocks, "project-a", "scene-1.md"),
      "# scene\n\na\n",
    );
    const deps = {
      dataDir: dir,
      logger: silent,
    } as unknown as ApplyExecutorDeps;
    expect(await syncSceneIndex(deps, new Set())).toBe(true);
    expect(fs.existsSync(path.join(dir, ".metadata", "scene_index"))).toBe(
      false,
    );
  });

  it("inline L2 is a no-op while consolidation is enabled (the gate stays)", async () => {
    const runner = createL2Runner({
      pluginDataDir: dir,
      cfg: { consolidation: { enabled: true } } as never,
      openclawConfig: {},
      vectorStore: undefined,
      logger: silent as never,
    });
    expect(await runner("session-1", "cursor-1")).toEqual({
      skipped: true,
      latestCursor: "cursor-1",
    });
  });
});
