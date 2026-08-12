/**
 * Scene Index: maintains a JSON index of all scene blocks for quick lookup.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseSceneBlock } from "./scene-format.js";
import { sceneBlocksDir, sceneBlocksRoot, sceneIndexPath, projectSlug } from "./scene-paths.js";

export interface SceneIndexEntry {
  filename: string;
  summary: string;
  heat: number;
  created: string;
  updated: string;
}

/**
 * Read the scene index from disk.
 *
 * The index is written exclusively by syncSceneIndex() (engineering side).
 * The LLM is sandboxed to scene_blocks/ and cannot access this file.
 */
export async function readSceneIndex(dataDir: string, projectId?: string): Promise<SceneIndexEntry[]> {
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
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Write the scene index to disk.
 */
export async function writeSceneIndex(
  dataDir: string,
  entries: SceneIndexEntry[],
  projectId?: string,
): Promise<void> {
  const indexPath = sceneIndexPath(dataDir, projectId);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Rebuild scene index by scanning all .md files in the scene_blocks directory.
 */
export async function syncSceneIndex(dataDir: string, projectId?: string): Promise<SceneIndexEntry[]> {
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
export async function readAllSceneIndexes(dataDir: string): Promise<ProjectSceneIndex[]> {
  let slugs: string[];
  try {
    slugs = (await fs.readdir(sceneBlocksRoot(dataDir), { withFileTypes: true }))
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
export async function syncSceneIndexAllProjects(dataDir: string): Promise<void> {
  let slugs: string[];
  try {
    slugs = (await fs.readdir(sceneBlocksRoot(dataDir), { withFileTypes: true }))
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
async function syncSceneIndexBySlug(dataDir: string, slug: string): Promise<SceneIndexEntry[]> {
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
      });
    } catch {
      // File may have been deleted between readdir and readFile (e.g. by concurrent
      // SceneExtractor soft-delete). Skip it and continue syncing the rest.
      continue;
    }
  }

  const indexPath = path.join(dataDir, ".metadata", "scene_index", `${slug}.json`);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), "utf-8");
  return entries;
}

/** Same as readSceneIndex, but keyed by an on-disk slug instead of a project id. */
export async function readSceneIndexBySlug(dataDir: string, slug: string): Promise<SceneIndexEntry[]> {
  const indexPath = path.join(dataDir, ".metadata", "scene_index", `${slug}.json`);
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as SceneIndexEntry[];
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.filename === "string") : [];
  } catch {
    return [];
  }
}

export { projectSlug };
