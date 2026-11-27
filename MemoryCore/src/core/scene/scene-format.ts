/**
 * Scene Block file format: parse and format the META-delimited Markdown files.
 */

export interface SceneBlockMeta {
  created: string;
  updated: string;
  summary: string;
  heat: number;
  /**
   * Latest *conversation* time (ISO 8601 UTC) whose memories have been merged
   * into this scene. Maintained by code after each L2 run — never by the LLM.
   *
   * `updated` is the write time and keeps moving forward even when an old,
   * late-arriving memory is processed, so it cannot tell "newer fact" from
   * "older fact replayed out of order". This field can. Optional: scenes
   * written by older versions simply lack it.
   */
  last_event_time?: string;
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
  const lastEventTime = extractMetaField(metaBlock, "last_event_time");
  if (lastEventTime) meta.last_event_time = lastEventTime;

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
    // 只有存在时才输出，保证没有该字段的旧场景格式化结果与升级前逐字节一致
    ...(meta.last_event_time ? [`last_event_time: ${meta.last_event_time}`] : []),
    META_END,
  ].join("\n");
}

function extractMetaField(metaBlock: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
  const m = metaBlock.match(re);
  return m ? m[1]!.trim() : "";
}
