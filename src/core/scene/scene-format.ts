/**
 * Scene Block file format: parse and format the META-delimited Markdown files.
 */

import {
  PROVENANCE_KEY,
  readProvenance,
  type Provenance,
} from "../record/provenance.js";

export interface SceneBlockMeta {
  created: string;
  updated: string;
  summary: string;
  heat: number;
  /** tz-05: the scope attribute of the L2 carrier — "project" | "global". */
  scope?: string;
  /** Project the block belongs to; empty for the global scene directory. */
  project_id?: string;
  /**
   * The same chain L1 carries in `_tdai_provenance`, serialized as one JSON
   * line. A separate front-matter key per step would make the block unreadable
   * and would not survive a round trip through the LLM sandbox any better.
   */
  provenance?: Provenance;
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
  // tz-05 keys are optional: a block written before this package has none, and
  // absence must stay absence — a default "global" here would invent a scope
  // the writer never claimed.
  const scope = extractMetaField(metaBlock, "scope");
  if (scope) meta.scope = scope;
  const projectId = extractMetaField(metaBlock, "project_id");
  if (projectId) meta.project_id = projectId;
  const provenance = parseProvenanceLine(
    extractMetaField(metaBlock, "provenance"),
  );
  if (provenance) meta.provenance = provenance;

  return { filename, meta, content };
}

/**
 * Format a Scene Block back into file content.
 */
export function formatSceneBlock(
  meta: SceneBlockMeta,
  content: string,
): string {
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
    ...(meta.scope ? [`scope: ${meta.scope}`] : []),
    ...(meta.project_id ? [`project_id: ${meta.project_id}`] : []),
    ...(meta.provenance
      ? [`provenance: ${JSON.stringify(meta.provenance)}`]
      : []),
    META_END,
  ].join("\n");
}

/** A provenance line the LLM mangled is dropped, never half-read. */
function parseProvenanceLine(raw: string): Provenance | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return readProvenance({ [PROVENANCE_KEY]: parsed });
  } catch {
    return undefined;
  }
}

function extractMetaField(metaBlock: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
  const m = metaBlock.match(re);
  return m ? m[1]!.trim() : "";
}
