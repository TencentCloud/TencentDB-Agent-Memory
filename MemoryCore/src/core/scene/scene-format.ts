/**
 * Scene Block file format: parse and format the META-delimited Markdown files.
 */

/**
 * Hard per-file character budget for scene blocks (#1543).
 *
 * The ≤1500-char guidance previously lived only in extraction prompt text,
 * which is advisory by construction — heavy usage let scene blocks grow
 * monotonically. Enforcement now happens deterministically at the write path
 * (scene-extractor Phase 5) via enforceSceneBlockBudget().
 */
export const SCENE_BLOCK_CHAR_BUDGET = 1500;

const TRIM_MARKER = "\n\n> [scene-block] trimmed: exceeded the 1500-char budget and was truncated (issue #1543)";

export interface SceneBlockMeta {
  created: string;
  updated: string;
  summary: string;
  heat: number;
}

export interface SceneBlock {
  filename: string;
  meta: SceneBlockMeta;
  content: string;
}

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/**
 * Parse a Scene Block file into structured data.
 */
export function parseSceneBlock(raw: string, filename: string): SceneBlock {
  const startIdx = raw.indexOf(META_START);
  const endIdx = raw.indexOf(META_END);

  if (startIdx === -1 || endIdx === -1) {
    // No META section — treat entire file as content
    return {
      filename,
      meta: { created: "", updated: "", summary: "", heat: 0 },
      content: raw.trim(),
    };
  }

  const metaBlock = raw.slice(startIdx + META_START.length, endIdx).trim();
  const content = raw.slice(endIdx + META_END.length).trim();

  const meta: SceneBlockMeta = {
    created: extractMetaField(metaBlock, "created"),
    updated: extractMetaField(metaBlock, "updated"),
    summary: extractMetaField(metaBlock, "summary"),
    heat: parseInt(extractMetaField(metaBlock, "heat"), 10) || 0,
  };

  return { filename, meta, content };
}

/**
 * Format a Scene Block back into file content.
 */
export function formatSceneBlock(meta: SceneBlockMeta, content: string): string {
  return `${formatMeta(meta)}\n\n${content}`;
}

/**
 * Format the META section.
 */
export function formatMeta(meta: SceneBlockMeta): string {
  return [
    META_START,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `summary: ${meta.summary}`,
    `heat: ${meta.heat}`,
    META_END,
  ].join("\n");
}

function extractMetaField(metaBlock: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
  const m = metaBlock.match(re);
  return m ? m[1]!.trim() : "";
}

/**
 * Deterministically cap a scene block at SCENE_BLOCK_CHAR_BUDGET characters.
 *
 * The META header (when present) is structural and never trimmed; over-budget
 * size is reclaimed from the body, which keeps its leading (most recent)
 * lines and ends with a trim marker. Idempotent: enforcing an already-conforming
 * block returns it unchanged.
 */
export function enforceSceneBlockBudget(
  raw: string,
  budget: number = SCENE_BLOCK_CHAR_BUDGET,
): { content: string; trimmed: boolean } {
  if (raw.length <= budget) return { content: raw, trimmed: false };

  const endIdx = raw.indexOf(META_END);
  if (endIdx !== -1) {
    const metaPart = raw.slice(0, endIdx + META_END.length);
    const bodyBudget = Math.max(200, budget - metaPart.length - TRIM_MARKER.length);
    return { content: metaPart + raw.slice(metaPart.length, metaPart.length + bodyBudget) + TRIM_MARKER, trimmed: true };
  }
  return { content: raw.slice(0, Math.max(200, budget - TRIM_MARKER.length)) + TRIM_MARKER, trimmed: true };
}
