/**
 * Which project slugs an apply actually touched (tz-02 критерий 1c).
 *
 * The rebuild used to walk EVERY project after any apply, including a
 * persona-only one: an index of an untouched project was rewritten byte for
 * byte, which is invisible in content and very visible in mtime — and any
 * concurrent writer of that other project lost its entry to the round trip.
 *
 * The answer comes from the DIFF, never from the disk: a scan of
 * `scene_blocks/` returns whatever is there right now, including slugs a
 * parallel run is in the middle of writing.
 */
import { isSceneBlockRelPath } from "../block-paths.js";
import type { ApplyDiff } from "./schemas.js";

/** `scene_blocks/<slug>/<file>.md` → `<slug>`; the shape is guaranteed by
 * `isSceneBlockRelPath`, which the apply side already validates against. */
export function slugOfBlockPath(rel: string): string | null {
  return isSceneBlockRelPath(rel) ? (rel.split("/")[1] ?? null) : null;
}

/**
 * @returns the slugs to rebuild. An EMPTY set means "nothing to rebuild" —
 * not "rebuild everything": a diff that rewrote no scene block (persona only,
 * or records only) leaves every index correct as it stands.
 */
export function touchedSlugs(diff: ApplyDiff): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const op of diff.rewriteBlock ?? []) {
    const slug = slugOfBlockPath(op.path);
    if (slug !== null) slugs.add(slug);
  }
  return slugs;
}
