/**
 * zod schemas + ApplyOp/ApplyDiff types for the apply pipeline.
 *
 * Split from validate.ts to keep that file ≤150 lines (zod schemas are
 * declarative, validation logic is procedural — different concerns).
 */

import { z } from "zod";
import {
  MAX_DELETE_L1_OPS,
  MAX_MERGE_CLUSTER,
  MAX_MERGE_OPS,
  MAX_PRESENTED_IDS,
  MAX_REWRITE_OPS,
  MAX_L1_CONTENT_CHARS,
  PERSONA_LIMIT_CHARS,
  SCENE_LIMIT_CHARS,
} from "../limits.js";

/** All apply ops a diff may carry. Used as the set-membership domain for
 * assertOpsSubset (the role's ops_subset is a subset of this). */
export type ApplyOp =
  "deleteL1" | "merge" | "rewriteBlock" | "rewriteRecord" | "rewritePersona";

/** Untyped diff shape (post-parse; only the ops + payloads we act on). */
export interface ApplyDiff {
  deleteL1?: Array<{ id: string; updatedAt: string }>;
  merge?: Array<{ cluster: string[]; target: string; content: string }>;
  rewriteBlock?: Array<{ path: string; content: string }>;
  rewriteRecord?: Array<{ id: string; updatedAt: string; content: string }>;
  rewritePersona?: string;
}

// The element schemas are exported because the diff is parsed ONE OPERATION
// AT A TIME (salvage.ts): a broken element is dropped and named, never a
// reason to discard the batch. Parsing the array as a whole cannot do that.
export const deleteL1OpSchema = z.strictObject({
  id: z.string().min(1),
  updatedAt: z.string(),
});

export const mergeOpSchema = z.strictObject({
  cluster: z.array(z.string().min(1)).min(2).max(MAX_MERGE_CLUSTER),
  target: z.string().min(1),
  content: z.string().max(4000),
});

export const rewriteBlockOpSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string().max(SCENE_LIMIT_CHARS),
});

export const rewriteRecordOpSchema = z.strictObject({
  id: z.string().min(1),
  updatedAt: z.string(),
  content: z.string().max(MAX_L1_CONTENT_CHARS),
});

export const personaSchema = z.string().max(PERSONA_LIMIT_CHARS);

export interface DiffSectionSpec {
  schema: z.ZodType;
  /** Count cap: over it the WHOLE request is refused (schemas, not salvage —
   * a role this far outside its contract did not mistype one op). */
  cap: number;
  /** Field that names one op in a report: "id" / "target" / "path". */
  key: string;
}

/** Per-section element schema + count cap + how to name one op in a report.
 * ONE table, so adding a section does not multiply branches in salvage.ts. */
export const ARRAY_SECTIONS: Record<string, DiffSectionSpec> = {
  deleteL1: { schema: deleteL1OpSchema, cap: MAX_DELETE_L1_OPS, key: "id" },
  merge: { schema: mergeOpSchema, cap: MAX_MERGE_OPS, key: "target" },
  rewriteBlock: {
    schema: rewriteBlockOpSchema,
    cap: MAX_REWRITE_OPS,
    key: "path",
  },
  rewriteRecord: {
    schema: rewriteRecordOpSchema,
    cap: MAX_REWRITE_OPS,
    key: "id",
  },
};

export const applyRequestSchema = z.strictObject({
  /** tz-09 Ф6: the HTTP path is the ONE place a run id travels in the body —
   * an internal caller passes a RunContext as the second argument instead.
   * Optional here widens the strict object; every pre-tz-09 body stays valid. */
  runId: z.string().optional(),
  /** Deliberately unparsed here: the envelope is OUR payload and stays
   * strict, while the diff is the role's output and is salvaged per-op. */
  diff: z.unknown(),
  manifest: z.strictObject({
    baseline: z.record(z.string(), z.string()),
  }),
  context: z.strictObject({
    presentedRecordIds: z.array(z.string()).max(MAX_PRESENTED_IDS),
  }),
});
