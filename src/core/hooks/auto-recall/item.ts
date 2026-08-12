/**
 * Pre-tz-05 projection of a store hit into a `RecallItem`, plus the single
 * render point for the prompt lines (tz-10 C10.3 / C10.7).
 *
 * Pure: no IO, no time, no globals. What the store does not know stays
 * unknown — `userId: null`, `sourceIds: []`, `provenance.status: "unknown"`.
 * Substituting a global/default here is what C10.7 forbids: it would make a
 * record look owned when nobody knows who owns it. tz-05 fills the same
 * fields natively and flips `status` without changing this contract.
 */

import type { MemoryRecord } from "../../record/l1-reader.js";
import type { L1FtsResult, L1SearchResult } from "../../store/types.js";
import {
  RECALL_ITEM_SCHEMA_VERSION,
  type FormatableMemory,
  type RecallItem,
} from "./types.js";
import {
  formatMemoryLine,
  ftsResultToFormatable,
  recordToFormatable,
  vectorResultToFormatable,
} from "./format.js";

/** Score triple carried from the strategy that produced the hit. */
export interface ItemScore {
  raw: number;
  final: number;
  reasons: string[];
}

/** Producer tag: which leg of the search path built this item. */
export type ItemProducer =
  "l1-fts" | "l1-vector" | "l1-record" | "l1-hybrid-rrf";

function projectItem(opts: {
  memoryId: string;
  formatable: FormatableMemory;
  scope: RecallItem["scope"];
  producer: ItemProducer;
  score: ItemScore;
  createdAt?: string;
  updatedAt?: string;
}): RecallItem {
  return {
    schemaVersion: RECALL_ITEM_SCHEMA_VERSION,
    memoryId: opts.memoryId,
    kind: "l1",
    content: opts.formatable.content,
    formatable: opts.formatable,
    scope: opts.scope,
    provenance: {
      sourceIds: [],
      producer: opts.producer,
      createdAt: opts.createdAt ?? "",
      updatedAt: opts.updatedAt ?? "",
      status: "unknown",
    },
    score: opts.score,
  };
}

/** FTS5 hit → item. `scope`/`project_id` come straight from the row. */
export function ftsResultToItem(r: L1FtsResult, score: ItemScore): RecallItem {
  return projectItem({
    memoryId: r.record_id,
    formatable: ftsResultToFormatable(r),
    scope: {
      userId: null,
      projectId: r.project_id,
      scope: r.scope,
      sessionKey: r.session_key,
      sessionId: r.session_id,
    },
    producer: "l1-fts",
    score,
  });
}

/** Vector/native-hybrid hit → item. */
export function vectorResultToItem(
  r: L1SearchResult,
  score: ItemScore,
  producer: ItemProducer = "l1-vector",
): RecallItem {
  return projectItem({
    memoryId: r.record_id,
    formatable: vectorResultToFormatable(r),
    scope: {
      userId: null,
      projectId: r.project_id,
      scope: r.scope,
      sessionKey: r.session_key,
      sessionId: r.session_id,
    },
    producer,
    score,
  });
}

/**
 * Full record → item. Only the hybrid keyword leg builds records; it also
 * carries the row's own `scope`/`project_id`, which the record shape does not
 * have room for (a `MemoryRecord` knows `projectId` but not whether the row
 * was tagged `project` or `global`).
 */
export function recordToItem(
  record: MemoryRecord,
  score: ItemScore,
  rowScope: { scope?: string; project_id?: string },
  producer: ItemProducer = "l1-record",
): RecallItem {
  return projectItem({
    memoryId: record.id,
    formatable: recordToFormatable(record),
    scope: {
      userId: null,
      projectId: rowScope.project_id ?? record.projectId,
      scope: rowScope.scope,
      sessionKey: record.sessionKey,
      sessionId: record.sessionId,
    },
    producer,
    score,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/** Rebuild an item with a different score (multiplier applied downstream). */
export function withScore(item: RecallItem, score: ItemScore): RecallItem {
  return { ...item, score };
}

/**
 * The one place a `RecallItem` becomes a prompt line. Everything downstream
 * (budget, injection, probe) works on items and renders through here, so the
 * text can never disagree with the structured data.
 */
export function renderItems(items: RecallItem[]): string[] {
  return items.map((i) => formatMemoryLine(i.formatable));
}
