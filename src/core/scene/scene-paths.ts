/**
 * Scene storage layout: L2 scene blocks are physically separated per project.
 *
 *   scene_blocks/<slug>/*.md         — blocks of one project (LLM sandbox root)
 *   .metadata/scene_index/<slug>.json — index of that project (engineering-only)
 *
 * Separation is physical rather than a filter on a shared directory because the
 * extraction LLM is sandboxed to the blocks directory and merges whatever it
 * finds there — a shared directory would let it fold another project's scenes
 * into the current one.
 *
 * Blocks written before this layout live flat in `scene_blocks/*.md`; they carry
 * no project and are simply not read anymore.
 */

import path from "node:path";
import { createHash } from "node:crypto";

/** Slug for memories that carry no project id (empty `project_id`). */
export const GLOBAL_SCENE_SLUG = "_global";

/**
 * Filesystem-safe directory name for a project id.
 *
 * `<basename>-<hash8>` — the basename keeps the directory readable, the hash of
 * the full id keeps two projects with the same basename apart.
 */
export function projectSlug(projectId?: string): string {
  const id = (projectId ?? "").trim();
  if (!id) return GLOBAL_SCENE_SLUG;

  const base = path.basename(id).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 8);
  return base ? `${base}-${hash}` : hash;
}

/** Directory holding one project's scene blocks (also the extraction LLM's sandbox root). */
export function sceneBlocksDir(dataDir: string, projectId?: string): string {
  return path.join(dataDir, "scene_blocks", projectSlug(projectId));
}

/** Index file for one project's scene blocks. Lives outside the sandbox on purpose. */
export function sceneIndexPath(dataDir: string, projectId?: string): string {
  return path.join(dataDir, ".metadata", "scene_index", `${projectSlug(projectId)}.json`);
}

/** Root of all per-project block directories. */
export function sceneBlocksRoot(dataDir: string): string {
  return path.join(dataDir, "scene_blocks");
}
