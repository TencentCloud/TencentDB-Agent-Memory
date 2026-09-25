/**
 * Derive the scene index from L2 profile rows (phase-2 task T2.1).
 *
 * The file-backed pipeline keeps a `.metadata/scene_index.json` that
 * `syncSceneIndex()` rebuilds by scanning `scene_blocks/`. A row-backed store
 * needs no such sidecar: the rows already carry the block content, so the index
 * is a projection of them and can be computed on demand.
 *
 * This module deliberately holds no path knowledge. It selects rows by type and
 * isolation, and the row's own `filename` becomes the entry's filename — the
 * same value `syncSceneIndex()` gets from the directory listing, so both
 * producers agree without either one spelling a prefix (design doc D12 ①).
 */

import type { ProfileIsolation } from "../profile/profile-scope.js";
import { profileScopeFilter } from "../profile/profile-scope.js";
import type { ProfileRowCapableStore } from "../store/types.js";
import { parseSceneBlock } from "./scene-format.js";
import type { SceneIndexEntry } from "./scene-index.js";

/**
 * Build scene index entries from the L2 rows of one isolation scope.
 *
 * @param store     Data plane holding the profile rows.
 * @param isolation Tenancy to read; omitted reads the store's whole L2 set.
 * @returns Entries sorted by filename, so repeated calls are comparable.
 *          Ordering for display is the caller's business —
 *          `generateSceneNavigation()` re-sorts by heat.
 *
 * Heat comes from the block's META section. M4 (T4.3) will prefer a dedicated
 * `heat` row column and keep this as the fallback for rows written before it.
 */
export async function deriveSceneIndexFromProfiles(
  store: ProfileRowCapableStore,
  isolation?: ProfileIsolation,
): Promise<SceneIndexEntry[]> {
  const rows = await store.queryProfiles(profileScopeFilter(isolation, { type: "l2" }));

  return rows
    .map((row) => {
      const { meta } = parseSceneBlock(row.content, row.filename);
      return {
        filename: row.filename,
        summary: meta.summary,
        heat: meta.heat,
        created: meta.created,
        updated: meta.updated,
      };
    })
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
}
