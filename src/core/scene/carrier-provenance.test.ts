/**
 * tz-05 Ф5 — the L2 and L3 carriers write scope and provenance, and read them
 * back. The write goes through the tz-03b commit point, not a private path:
 * the test installs the composed observer and then only announces mutations,
 * exactly as the gateway does (server.ts:336).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  notifyCommitted,
  setCommitObserver,
  type MemoryCommitObserver,
} from "../record/commit-port.js";
import { withProvenance } from "../record/provenance-observer.js";
import { readSceneIndex } from "./scene-index.js";
import { parseSceneBlock } from "./scene-format.js";
import { sceneBlocksDir } from "./scene-paths.js";
import { readProfileAttributes } from "../profile/profile-provenance.js";
import { MAX_CHAIN } from "../record/provenance.js";

const PROJECT = "/repo/alpha";
const OTHER = "/repo/beta";

let dir: string;
let commits: number;

/** The inner observer stands in for the counters: composition, not replacement. */
const inner: MemoryCommitObserver = {
  onCommitted: () => {
    commits += 1;
  },
};

async function writeBlock(projectId: string, filename: string): Promise<void> {
  const d = sceneBlocksDir(dir, projectId);
  await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(
    path.join(d, filename),
    [
      "-----META-START-----",
      "created: 2026-07-01T00:00:00Z",
      "updated: 2026-07-02T00:00:00Z",
      `summary: ${filename} summary`,
      "heat: 3",
      "-----META-END-----",
      "",
      `# ${filename}`,
      "",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  );
}

/** Announce a scene mutation and wait for the observer to finish stamping. */
async function commitScene(
  projectId?: string,
  source = "scene-extract",
): Promise<void> {
  const before = commits;
  notifyCommitted({
    carrier: "scene",
    kind: "update",
    affected: 1,
    source,
    at: new Date().toISOString(),
    ...(projectId ? { projectId } : {}),
  });
  // notifyCommitted never awaits (commit-port.ts:47) — the inner observer
  // running is the signal that the stamping before it is done.
  for (let i = 0; i < 200 && commits === before; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(commits).toBe(before + 1);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "carrier-prov-"));
  commits = 0;
  setCommitObserver(withProvenance(inner, dir));
});

afterEach(() => {
  setCommitObserver(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("L2 carrier", () => {
  it("stamps scope, project_id and a chain into the block and the index", async () => {
    await writeBlock(PROJECT, "deploy.md");
    await commitScene(PROJECT);

    const raw = await fsp.readFile(
      path.join(sceneBlocksDir(dir, PROJECT), "deploy.md"),
      "utf-8",
    );
    const block = parseSceneBlock(raw, "deploy.md");
    expect(block.meta.scope).toBe("project");
    expect(block.meta.project_id).toBe(PROJECT);
    expect(block.meta.provenance?.source).toBe("role-run");
    expect(block.meta.provenance?.chain).toHaveLength(1);
    // The stamp must not eat the block: summary and body survive verbatim.
    expect(block.meta.summary).toBe("deploy.md summary");
    expect(block.content).toContain("body");

    const entry = (await readSceneIndex(dir, PROJECT))[0];
    expect(entry?.scope).toBe("project");
    expect(entry?.project_id).toBe(PROJECT);
    expect(entry?.provenance?.chain).toHaveLength(1);
    // The index is resynced AFTER the stamp, so its digest matches the bytes.
    const { blockDigest } = await import("./scene-index.js");
    expect(entry?.digest).toBe(blockDigest(raw));
  });

  it("touches only the project that was announced", async () => {
    await writeBlock(PROJECT, "a.md");
    await writeBlock(OTHER, "b.md");
    await commitScene(PROJECT);

    const mine = (await readSceneIndex(dir, PROJECT))[0];
    const theirs = parseSceneBlock(
      await fsp.readFile(
        path.join(sceneBlocksDir(dir, OTHER), "b.md"),
        "utf-8",
      ),
      "b.md",
    );
    expect(mine?.project_id).toBe(PROJECT);
    expect(theirs.meta.scope).toBeUndefined();
    expect(theirs.meta.provenance).toBeUndefined();
  });

  it("stamps every project when the mutation named none, as an import", async () => {
    await writeBlock(PROJECT, "a.md");
    await writeBlock(OTHER, "b.md");
    await commitScene(undefined, "profile-sync");

    for (const p of [PROJECT, OTHER]) {
      const entry = (await readSceneIndex(dir, p))[0];
      expect([p, entry?.provenance?.source]).toEqual([p, "import"]);
      // A wholesale replacement cannot know whose blocks these are, so it must
      // not invent a project id for them.
      expect([p, entry?.project_id]).toEqual([p, ""]);
    }
  });

  it("appends to the chain and collapses past the cap", async () => {
    await writeBlock(PROJECT, "a.md");
    for (let i = 0; i < MAX_CHAIN + 3; i += 1) await commitScene(PROJECT);

    const entry = (await readSceneIndex(dir, PROJECT))[0];
    expect(entry?.provenance?.chain).toHaveLength(MAX_CHAIN);
    const first = entry?.provenance?.chain[0] as { collapsed?: number };
    expect(first.collapsed).toBe(MAX_CHAIN + 3 - (MAX_CHAIN - 1));
  });
});

describe("L3 carrier", () => {
  it("records the profile's scope and chain beside persona.md", async () => {
    const before = commits;
    notifyCommitted({
      carrier: "profile",
      kind: "update",
      affected: 1,
      source: "persona-generation",
      at: new Date().toISOString(),
    });
    for (let i = 0; i < 200 && commits === before; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const attrs = await readProfileAttributes(dir, "persona.md");
    expect(attrs?.scope).toBe("global");
    expect(attrs?.provenance?.chain).toHaveLength(1);
    expect(attrs?.provenance?.source).toBe("role-run");
    // persona.md itself is untouched — the apply manifest hashes it.
    expect(fs.existsSync(path.join(dir, "persona.md"))).toBe(false);
  });
});

/**
 * The extraction LLM can write scene blocks — that is its job. It must not be
 * able to write their history: the index lives outside its sandbox and is the
 * truth, so front-matter is a copy, not a claim.
 */
describe("a model editing its own block", () => {
  it("cannot forge, inflate or erase the chain", async () => {
    await writeBlock(PROJECT, "deploy.md");
    await commitScene(PROJECT);
    await commitScene(PROJECT);
    const honest = (await readSceneIndex(dir, PROJECT))[0];
    expect(honest?.provenance?.chain).toHaveLength(2);

    // The model rewrites the block: a different project, a forged chain that
    // claims a hand-written origin, and a summary it is genuinely allowed to
    // change.
    const file = path.join(sceneBlocksDir(dir, PROJECT), "deploy.md");
    await fsp.writeFile(
      file,
      [
        "-----META-START-----",
        "created: 2026-07-01T00:00:00Z",
        "updated: 2026-07-02T00:00:00Z",
        "summary: rewritten by the model",
        "heat: 9",
        "scope: global",
        "project_id: /repo/somewhere-else",
        `provenance: ${JSON.stringify({
          source: "manual",
          createdAt: "2000-01-01T00:00:00.000Z",
          chain: [
            {
              role: "human",
              action: "authored",
              at: "2000-01-01T00:00:00.000Z",
            },
          ],
        })}`,
        "-----META-END-----",
        "",
        "# forged",
        "",
      ].join("\n"),
      "utf-8",
    );
    await commitScene(PROJECT);

    const entry = (await readSceneIndex(dir, PROJECT))[0];
    // Three real steps: the forged one never entered the chain.
    expect(entry?.provenance?.chain).toHaveLength(3);
    expect(entry?.provenance?.source).toBe("role-run");
    expect(
      (entry?.provenance?.chain ?? []).some(
        (s) => (s as { role?: string }).role === "human",
      ),
    ).toBe(false);
    expect(entry?.scope).toBe("project");
    expect(entry?.project_id).toBe(PROJECT);
    // Content the model IS allowed to own still travels.
    expect(entry?.summary).toBe("rewritten by the model");

    // And the block's own copy is put back in agreement with the index.
    const block = parseSceneBlock(
      await fsp.readFile(file, "utf-8"),
      "deploy.md",
    );
    expect(block.meta.project_id).toBe(PROJECT);
    expect(block.meta.provenance?.chain).toHaveLength(3);
  });

  it("a block renamed by the normalizer keeps its scope and its chain", async () => {
    // The index is keyed by filename, and the extractor renames blocks whose
    // name the model wrote sloppily — on EVERY extraction. Before the entries
    // learned to move with the files, that rename alone erased the block's
    // scope and its whole chain, and the model picks the filenames.
    await writeBlock(PROJECT, "Daily Rhythm.md");
    await commitScene(PROJECT);
    expect(
      (await readSceneIndex(dir, PROJECT))[0]?.provenance?.chain,
    ).toHaveLength(1);

    const { SceneExtractor } = await import("./scene-extractor.js");
    const extractor = new SceneExtractor({
      dataDir: dir,
      config: {},
      projectId: PROJECT,
      // The run leaves the tree as it is: the rename is what this test is about.
      llmRunner: { run: () => Promise.resolve("done") } as never,
    });
    const result = await extractor.extract([
      { content: "нечто", created_at: "2026-08-01T00:00:00.000Z" },
    ]);
    expect(result.success).toBe(true);

    const entries = await readSceneIndex(dir, PROJECT);
    expect(entries.map((e) => e.filename)).toEqual(["Daily-Rhythm.md"]);
    expect(entries[0]?.scope).toBe("project");
    expect(entries[0]?.project_id).toBe(PROJECT);
    expect(entries[0]?.provenance?.chain).toHaveLength(1);
  });
});
