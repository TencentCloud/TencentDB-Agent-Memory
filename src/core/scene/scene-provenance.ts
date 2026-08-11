/**
 * tz-05 Ф5 — scope and provenance for the L2 carrier.
 *
 * Scene blocks are written by a SANDBOXED LLM (scene-extractor's workspaceDir),
 * so there is no single write to intercept and no way to make the model author
 * these fields reliably. The engineering side stamps them once the tree has
 * settled, at the tz-03b commit point — the same moment the counters recompute.
 *
 * `project_id` is stamped rather than derived because the on-disk slug is a
 * one-way hash (`scene-paths.ts:33`): the directory name cannot give the
 * project back, so whoever mutates has to say who they were.
 *
 * A4b ("the key belongs to the core, nothing on the input path may write it")
 * holds here the same way it holds for L1 — but NOT through the front-matter,
 * which lives inside the LLM's sandbox and is therefore model-writable. The
 * truth is the scene index (`.metadata/scene_index/<slug>.json`, outside the
 * sandbox root): the previous chain is read from there, the new one is written
 * there, and `syncSceneIndexBySlug` refuses to take these fields off disk. The
 * front-matter keeps a human-readable copy, and a model editing it changes
 * exactly nothing — the next stamp overwrites the copy from the index.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { formatSceneBlock, parseSceneBlock } from "./scene-format.js";
import { readSceneIndexBySlug, type CarrierAttributes } from "./scene-index.js";
import { sceneBlocksRoot, GLOBAL_SCENE_SLUG } from "./scene-paths.js";
import {
  appendStep,
  type Provenance,
  type ProvenanceSource,
} from "../record/provenance.js";

export interface SceneStamp {
  role: string;
  action: string;
  source: ProvenanceSource;
  /** Absent when the mutation did not name a project (a wholesale tree
   * replacement, e.g. a profile pull) — then the block keeps whatever it
   * already claimed instead of being relabelled by a guess. */
  projectId?: string;
}

/**
 * Stamp every block of one slug. Returns how many files were rewritten.
 *
 * Never throws: this runs off the commit port, where a failure must not undo
 * the mutation that already happened (commit-port.ts:47).
 */
export async function stampSceneSlug(
  dataDir: string,
  slug: string,
  stamp: SceneStamp,
  now: string = new Date().toISOString(),
): Promise<Map<string, CarrierAttributes>> {
  const dir = path.join(sceneBlocksRoot(dataDir), slug);
  const stamped = new Map<string, CarrierAttributes>();
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return stamped;
  }

  // Previous state comes from the index, never from the block: the block is
  // model-writable, so reading the chain back from it would let a model
  // rewrite its own history by editing one file.
  const carried = new Map(
    (await readSceneIndexBySlug(dataDir, slug)).map((e) => [e.filename, e]),
  );

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = await fs.readFile(full, "utf-8");
      const block = parseSceneBlock(raw, file);
      const known = carried.get(file);
      const previous: Provenance | undefined = known?.provenance;
      const next = appendStep(
        previous,
        { role: stamp.role, action: stamp.action, at: now },
        stamp.source,
        now,
      );
      const scoped = scopeFor(slug, stamp, known?.scope, known?.project_id);
      const meta = {
        ...block.meta,
        ...scoped,
        provenance: next,
      };
      // The file gets a copy for humans; the index gets the truth (caller).
      await fs.writeFile(full, formatSceneBlock(meta, block.content), "utf-8");
      stamped.set(file, { ...scoped, provenance: next });
    } catch {
      // Deleted between readdir and write, or unreadable — skip it; the next
      // mutation stamps it, and the index still reports what is on disk.
      continue;
    }
  }
  return stamped;
}

/** Stamp every project's blocks. Used when the mutation replaced the whole tree. */
export async function stampAllSceneSlugs(
  dataDir: string,
  stamp: SceneStamp,
  now?: string,
): Promise<Map<string, Map<string, CarrierAttributes>>> {
  const bySlug = new Map<string, Map<string, CarrierAttributes>>();
  let slugs: string[];
  try {
    slugs = (
      await fs.readdir(sceneBlocksRoot(dataDir), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return bySlug;
  }
  for (const slug of slugs) {
    bySlug.set(slug, await stampSceneSlug(dataDir, slug, stamp, now));
  }
  return bySlug;
}

/**
 * The scope attribute for one block. Known project id wins; otherwise keep what
 * the block already claims; only the global directory can be labelled without
 * knowing anything, because its slug IS the statement.
 */
function scopeFor(
  slug: string,
  stamp: SceneStamp,
  currentScope: string | undefined,
  currentProject: string | undefined,
): { scope?: string; project_id?: string } {
  if (stamp.projectId) return { scope: "project", project_id: stamp.projectId };
  if (currentScope) return { scope: currentScope, project_id: currentProject };
  if (slug === GLOBAL_SCENE_SLUG) return { scope: "global" };
  return {};
}
