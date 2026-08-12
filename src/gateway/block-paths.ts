/**
 * Single authority for addressable memory-file paths (wave tdai-memory-
 * subagents-2026-08-02, keeper-tools). Both the read side (GET /memory/
 * blocks?path=, memory-routes.ts) and the write side (ApplyExecutor
 * rewriteBlock, apply-executor.ts) validate against THIS module — previously
 * each had its own shape (the apply side used an ASCII-only regex that
 * rejected real Cyrillic scene filenames, silently dropping rewriteBlock ops
 * for them).
 *
 * Shape: `scene_blocks/<slug>/<file>.md` (exactly two path segments under
 * scene_blocks, no nesting) + `persona.md`. Unicode is allowed (Cyrillic/CJK
 * scene names are real). Pure functions — no fs, no writes; never enters the
 * nogo-records-rewrite allowlist.
 */

const SCENE_ROOT = "scene_blocks";
const PERSONA = "persona.md";

/** True for a relative path shaped exactly `scene_blocks/<slug>/<file>.md`. */
export function isSceneBlockRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/") || rel.startsWith("~")) return false;
  const parts = rel.split("/");
  if (parts.length !== 3) return false;
  const [root, slug, file] = parts;
  if (root !== SCENE_ROOT) return false;
  if (!slug || !file) return false;
  if (slug === ".." || file === "..") return false;
  if (slug.includes("/") || file.includes("/")) return false;
  if (!file.endsWith(".md")) return false;
  return true;
}

/** True for `scene_blocks/**` (via isSceneBlockRelPath) or `persona.md`. */
export function isAddressableBlockPath(rel: string): boolean {
  return rel === PERSONA || isSceneBlockRelPath(rel);
}

/** The single regex-shaped predicate used by the apply side. */
export function isSceneBlockRelPathOrPersona(rel: string): boolean {
  return isAddressableBlockPath(rel);
}
