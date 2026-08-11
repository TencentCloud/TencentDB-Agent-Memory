/**
 * Committed-tree fallback for syncSceneIndexAllProjects.
 *
 * The committed scene-index.ts scans scene_blocks/ flat and cannot index
 * the per-project scene_blocks/<slug>/ layout that apply rewrites, so
 * mirror the per-project rebuild here (same layout memory-routes.ts
 * /memory/validate expects: .metadata/scene_index/<slug>.json).
 * Superseded by the I3/I4 module export once that lands.
 *
 * Split from apply-route.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import { parseSceneBlock } from "../../core/scene/scene-format.js";
import * as sceneIndex from "../../core/scene/scene-index.js";
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
  const blocksRoot = path.join(deps.dataDir, "scene_blocks");

  for (const slug of slugs) {
    const blocksDir = path.join(blocksRoot, slug);
    let files: string[];
    try {
      files = (await fs.promises.readdir(blocksDir)).filter((f) =>
        f.endsWith(".md"),
      );
    } catch {
      continue;
    }

    const entries: sceneIndex.SceneIndexEntry[] = [];
    for (const file of files) {
      try {
        const raw = await fs.promises.readFile(
          path.join(blocksDir, file),
          "utf-8",
        );
        const block = parseSceneBlock(raw, file);
        entries.push({
          filename: file,
          summary: block.meta.summary,
          heat: block.meta.heat,
          created: block.meta.created,
          updated: block.meta.updated,
          digest: sceneIndex.blockDigest(raw),
          // tz-05: the apply path rebuilds the index from the committed tree,
          // so it has to copy the same carrier fields the normal sync does —
          // otherwise an apply silently erases scope from every entry.
          scope: block.meta.scope ?? "",
          project_id: block.meta.project_id ?? "",
          ...(block.meta.provenance
            ? { provenance: block.meta.provenance }
            : {}),
        });
      } catch {
        // Deleted between readdir and readFile — skip it, keep the rest.
        continue;
      }
    }

    const indexPath = path.join(
      deps.dataDir,
      ".metadata",
      "scene_index",
      `${slug}.json`,
    );
    await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.promises.writeFile(
      indexPath,
      JSON.stringify(entries, null, 2),
      "utf-8",
    );
  }
}
