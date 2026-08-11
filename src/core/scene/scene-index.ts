/**
 * Scene Index: maintains a JSON index of all scene blocks for quick lookup.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSceneBlock } from "./scene-format.js";
import {
  PROVENANCE_KEY,
  readProvenance,
  type Provenance,
} from "../record/provenance.js";
import {
  sceneBlocksDir,
  sceneBlocksRoot,
  sceneIndexPath,
  projectSlug,
} from "./scene-paths.js";

export interface SceneIndexEntry {
  filename: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
  /**
   * sha256 of the block's bytes as they were when this entry was written
   * (tz-02 критерий 1d).
   *
   * Without it "the file and the index agree by digest" is not an operational
   * check at all: the entry carried only metadata parsed OUT of the file, so
   * an index written from a stale snapshot looked exactly like a fresh one.
   * Empty string for an entry written before this field existed — absence is
   * "unknown", never "matches".
   */
  digest: string;
  /** tz-05 scope attribute, copied from the block's front-matter. Empty when
   * the block predates the package — absence is "unknown", never "global". */
  scope: string;
  project_id: string;
  /** Undefined when the block carries no chain. */
  provenance?: Provenance;
}

/** The digest of one scene block. One definition, both writers. */
export function blockDigest(raw: string): string {
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

/**
 * Read the scene index from disk.
 *
 * The index is written exclusively by syncSceneIndex() (engineering side).
 * The LLM is sandboxed to scene_blocks/ and cannot access this file.
 */
export async function readSceneIndex(
  dataDir: string,
  projectId?: string,
): Promise<SceneIndexEntry[]> {
  const indexPath = sceneIndexPath(dataDir, projectId);
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];

    const entries: SceneIndexEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;

      const filename = typeof item.filename === "string" ? item.filename : "";
      if (!filename) continue;

      entries.push({
        filename,
        summary: typeof item.summary === "string" ? item.summary : "",
        heat: typeof item.heat === "number" ? item.heat : 0,
        created: typeof item.created === "string" ? item.created : "",
        updated: typeof item.updated === "string" ? item.updated : "",
        // The whitelist is why this line has to exist: the reader rebuilds
        // the entry field by field, so a field nobody lists is dropped on
        // the way out no matter what the writer put in.
        digest: typeof item.digest === "string" ? item.digest : "",
        scope: typeof item.scope === "string" ? item.scope : "",
        project_id: typeof item.project_id === "string" ? item.project_id : "",
        // Same whitelist discipline: rebuilt through the reader that validates
        // the chain, so a hand-edited index cannot smuggle a bad shape in.
        ...(readProvenance({ [PROVENANCE_KEY]: item.provenance })
          ? {
              provenance: readProvenance({ [PROVENANCE_KEY]: item.provenance }),
            }
          : {}),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Rebuild scene index by scanning all .md files in the scene_blocks directory.
 */
export async function syncSceneIndex(
  dataDir: string,
  projectId?: string,
): Promise<SceneIndexEntry[]> {
  return syncSceneIndexBySlug(dataDir, projectSlug(projectId));
}

/** One project's slice of the scene store. */
export interface ProjectSceneIndex {
  slug: string;
  entries: SceneIndexEntry[];
}

/**
 * Read every project's index. Only L3 persona generation needs this — it
 * describes the user across projects; recall never crosses the project line.
 */
export async function readAllSceneIndexes(
  dataDir: string,
): Promise<ProjectSceneIndex[]> {
  let slugs: string[];
  try {
    slugs = (
      await fs.readdir(sceneBlocksRoot(dataDir), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const out: ProjectSceneIndex[] = [];
  for (const slug of slugs) {
    // Slugs are the on-disk directory names, so they are already their own key —
    // reading by slug avoids having to map back to the original project id.
    const entries = await readSceneIndexBySlug(dataDir, slug);
    if (entries.length > 0) out.push({ slug, entries });
  }
  return out;
}

/**
 * Rebuild every project's index from disk. Used after a profile pull replaces
 * the whole scene_blocks tree, where per-project ids are not known any more.
 */
export async function syncSceneIndexAllProjects(
  dataDir: string,
): Promise<void> {
  let slugs: string[];
  try {
    slugs = (
      await fs.readdir(sceneBlocksRoot(dataDir), { withFileTypes: true })
    )
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const slug of slugs) {
    await syncSceneIndexBySlug(dataDir, slug);
  }
}

/** Rebuild one project's index from the .md files on disk. */
async function syncSceneIndexBySlug(
  dataDir: string,
  slug: string,
): Promise<SceneIndexEntry[]> {
  const blocksDir = path.join(sceneBlocksRoot(dataDir), slug);
  let files: string[];
  try {
    files = (await fs.readdir(blocksDir)).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }

  const entries: SceneIndexEntry[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(blocksDir, file), "utf-8");
      const block = parseSceneBlock(raw, file);
      entries.push({
        filename: file,
        summary: block.meta.summary,
        heat: block.meta.heat,
        created: block.meta.created,
        updated: block.meta.updated,
        digest: blockDigest(raw),
        scope: block.meta.scope ?? "",
        project_id: block.meta.project_id ?? "",
        ...(block.meta.provenance ? { provenance: block.meta.provenance } : {}),
      });
    } catch {
      // File may have been deleted between readdir and readFile (e.g. by concurrent
      // SceneExtractor soft-delete). Skip it and continue syncing the rest.
      continue;
    }
  }

  const indexPath = path.join(
    dataDir,
    ".metadata",
    "scene_index",
    `${slug}.json`,
  );
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), "utf-8");
  return entries;
}

/** Same as readSceneIndex, but keyed by an on-disk slug instead of a project id. */
export async function readSceneIndexBySlug(
  dataDir: string,
  slug: string,
): Promise<SceneIndexEntry[]> {
  const indexPath = path.join(
    dataDir,
    ".metadata",
    "scene_index",
    `${slug}.json`,
  );
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as SceneIndexEntry[];
    return Array.isArray(parsed)
      ? parsed.filter((e) => e && typeof e.filename === "string")
      : [];
  } catch {
    return [];
  }
}

export { projectSlug };
