/**
 * Shared mechanical caps + format delimiters (ТЗ §5.6).
 *
 * Single source of truth for the memory subsystem. Importers:
 * - src/gateway/apply-executor.ts (apply path — zod caps, META guards)
 * - src/gateway/memory-routes.ts (read path — size limits in /memory/blocks, /memory/validate)
 *
 * consolidation/diff-builder.ts keeps its own copies (not in this group's
 * ownership; a later group migrates it). The values are intentionally
 * identical.
 */

/** Scene block char limit (memory-keeper role prompt cap, §5.6). */
export const SCENE_LIMIT_CHARS = 1500;
/** Persona char limit (memory-keeper role prompt cap, §5.6). */
export const PERSONA_LIMIT_CHARS = 2000;

/** Batch caps — upper bounds per diff section (safety nets; the diff the
 * orchestrator presents is already double-capped at ~20 records, §5.4). */
export const MAX_DELETE_L1_OPS = 500;
export const MAX_MERGE_OPS = 100;
export const MAX_REWRITE_OPS = 100;
export const MAX_MERGE_CLUSTER = 50;
export const MAX_PRESENTED_IDS = 5000;

/** L1 content cap — mirrors l1-extractor MAX_CONTENT_CHARS (600). */
export const MAX_L1_CONTENT_CHARS = 600;
/** Livelock cap for reindexAll retries (ТЗ §5.6). */
export const MAX_REINDEX_RETRIES = 2;

// Real META delimiters from scene-format.ts (rewrite guardrail must check the
// actual markers — a bare "META_START" substring would pass delimiter-less
// content that parseSceneBlock treats as body-only).
export const META_START = "-----META-START-----";
export const META_END = "-----META-END-----";
