/**
 * tz-05 — the apply path rebuilds the scene index, and it must rebuild it the
 * SAME way the core sync does.
 *
 * It used to keep its own copy of the loop, reading scope and provenance off
 * the block's front-matter. That made an ordinary apply destroy the chain of
 * every block whose front-matter copy was missing — no attacker needed — and
 * let a model relabel a block's project by editing its own file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncSceneIndexPerProject } from "./scene-index-fallback.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import {
  readSceneIndexBySlug,
  syncSceneIndexBySlug,
  writeCarrierAttributes,
} from "../../core/scene/scene-index.js";

const SLUG = "repo-alpha-1234abcd";
let dir: string;

/** Only `dataDir` is read by the rebuild; the rest of the deps never load. */
function deps(): ApplyExecutorDeps {
  return { dataDir: dir } as unknown as ApplyExecutorDeps;
}

async function writeBlock(front: string[]): Promise<void> {
  const blocks = path.join(dir, "scene_blocks", SLUG);
  await fsp.mkdir(blocks, { recursive: true });
  await fsp.writeFile(
    path.join(blocks, "deploy.md"),
    [
      "-----META-START-----",
      "created: 2026-08-01T00:00:00Z",
      "updated: 2026-08-01T00:00:00Z",
      "summary: deploy notes",
      "heat: 2",
      ...front,
      "-----META-END-----",
      "",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  );
}

/** The truth the index holds before an apply touches anything. */
const TRUE_CHAIN = {
  source: "role-run" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  chain: [
    { role: "scene-extract", action: "update", at: "2026-08-01T00:00:00.000Z" },
  ],
};

async function seedIndex(): Promise<void> {
  await syncSceneIndexBySlug(dir, SLUG);
  await writeCarrierAttributes(
    dir,
    SLUG,
    new Map([
      [
        "deploy.md",
        {
          scope: "project",
          project_id: "/repo/alpha",
          provenance: TRUE_CHAIN,
        },
      ],
    ]),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-index-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the apply path rebuilding the scene index", () => {
  it("keeps the chain of a block that carries no front-matter copy", async () => {
    await writeBlock([]);
    await seedIndex();

    await syncSceneIndexPerProject(deps(), new Set([SLUG]));

    const entry = (await readSceneIndexBySlug(dir, SLUG))[0];
    expect(entry?.provenance).toEqual(TRUE_CHAIN);
    expect(entry?.scope).toBe("project");
    expect(entry?.project_id).toBe("/repo/alpha");
  });

  it("ignores a forged front-matter copy", async () => {
    await writeBlock([]);
    await seedIndex();
    // The model rewrites its own block: another project, a chain that claims a
    // human wrote it. Correctly SHAPED, so validation alone cannot catch it.
    await writeBlock([
      "scope: global",
      "project_id: /repo/EVIL",
      `provenance: ${JSON.stringify({
        source: "manual",
        createdAt: "2000-01-01T00:00:00.000Z",
        chain: [
          { role: "human", action: "authored", at: "2000-01-01T00:00:00.000Z" },
        ],
      })}`,
    ]);

    await syncSceneIndexPerProject(deps(), new Set([SLUG]));

    const entry = (await readSceneIndexBySlug(dir, SLUG))[0];
    expect(entry?.scope).toBe("project");
    expect(entry?.project_id).toBe("/repo/alpha");
    expect(entry?.provenance).toEqual(TRUE_CHAIN);
    // Content the block legitimately owns still travels, and the digest is
    // recomputed from the bytes actually on disk.
    expect(entry?.summary).toBe("deploy notes");
    expect(entry?.digest).toHaveLength(64);
  });
});
