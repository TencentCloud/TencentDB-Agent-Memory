/**
 * Memory line formatting: build `FormatableMemory` from each search-result
 * type, and render a single natural-language line for prompt injection.
 *
 * Time semantics:
 *   - `timestamp` (点时间): when the activity/event happened
 *   - `activity_start_time` / `activity_end_time` (段时间): activity range
 */

import { formatForLLM } from "../../../utils/time.js";
import type { MemoryRecord } from "../../record/l1-reader.js";
import type { L1FtsResult, L1SearchResult } from "../../store/types.js";
import type { FormatableMemory } from "./types.js";

/**
 * Format a single memory record into a rich natural-language line for prompt injection.
 * Output examples:
 *   - [persona] 用户叫王小明，30岁，是一名软件工程师。
 *   - [episodic|旅行计划] 用户计划五月去日本旅行。(活动时间: 2025-05-01 ~ 2025-05-10)
 *   - [episodic] 用户今天加班到很晚。(活动时间: 2025-03-01)
 *   - [instruction] 用户要求回答时使用中文，保持简洁。
 */
export function formatMemoryLine(m: FormatableMemory): string {
  const tag = m.scene_name ? `${m.type}|${m.scene_name}` : m.type;
  let line = `- [${tag}] ${m.content}`;
  const start = formatTimestamp(m.activity_start_time);
  const end = formatTimestamp(m.activity_end_time);
  const point = formatTimestamp(m.timestamp);
  if (start && end) line += ` (活动时间: ${start} ~ ${end})`;
  else if (start) line += ` (活动时间: ${start}起)`;
  else if (end) line += ` (活动时间: 至${end})`;
  else if (point) line += ` (活动时间: ${point})`;
  return line;
}

/**
 * Format an ISO 8601 timestamp to a concise, timezone-aware string for display.
 * Uses the configured timezone (via time module).
 * - If the time part is 00:00:00 → show date only (e.g. "2025-03-01")
 * - Otherwise → show full ISO 8601 with offset
 * - Returns undefined for empty/invalid inputs.
 */
export function formatTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return undefined;
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/);
  if (match) {
    const timePart = match[2];
    if (!timePart || timePart === "00:00") return match[1];
  }
  return formatForLLM(ts);
}

/** Build a FormatableMemory from a full MemoryRecord (keyword search path). */
export function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  return {
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
  };
}

/** Build a FormatableMemory from a VectorSearchResult (embedding search path). */
export function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors */ }
  }
  return {
    type: r.type, content: r.content, scene_name: r.scene_name || undefined,
    activity_start_time: activityStart, activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

/** Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path). */
export function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors */ }
  }
  return {
    type: r.type, content: r.content, scene_name: r.scene_name || undefined,
    activity_start_time: activityStart, activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}
