/**
 * Per-project index rebuild for the apply path.
 *
 * This file used to carry its own copy of the rebuild loop, on the grounds
 * that the committed `scene-index.ts` scanned `scene_blocks/` flat. It does
 * not any more — and the copy had drifted into a second writer of the same
 * file with different rules, which erased provenance (tz-05). The rebuild now
 * belongs to `scene-index.ts` alone; this module only decides WHICH slugs get
 * rebuilt.
 *
 * Split from apply-route.ts to keep that file ≤150 lines.
 */

import { syncSceneIndexBySlug } from "../../core/scene/scene-index.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";

/**
 * @param slugs exactly the projects to rebuild. Reading them from the CALLER
 * and not from a `readdir` of `scene_blocks/` is the point (tz-02 критерий
 * 1c): a scan answers "what is on disk now", which includes projects a
 * concurrent run is writing and has nothing to do with this diff.
 */
export async function syncSceneIndexPerProject(
  deps: ApplyExecutorDeps,
  slugs: ReadonlySet<string>,
): Promise<void> {
  for (const slug of slugs) {
    await syncSceneIndexBySlug(deps.dataDir, slug);
  }
}
