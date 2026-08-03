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
  | "deleteL1"
  | "merge"
  | "rewriteBlock"
  | "rewriteRecord"
  | "rewritePersona";

/** Untyped diff shape (post-parse; only the ops + payloads we act on). */
export interface ApplyDiff {
  deleteL1?: Array<{ id: string; updatedAt: string }>;
  merge?: Array<{ cluster: string[]; target: string; content: string }>;
  rewriteBlock?: Array<{ path: string; content: string }>;
  rewriteRecord?: Array<{ id: string; updatedAt: string; content: string }>;
  rewritePersona?: string;
}

const deleteL1OpSchema = z.strictObject({
  id: z.string().min(1),
  updatedAt: z.string(),
});

const mergeOpSchema = z.strictObject({
  cluster: z.array(z.string().min(1)).min(2).max(MAX_MERGE_CLUSTER),
  target: z.string().min(1),
  content: z.string().max(4000),
});

const rewriteBlockOpSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string().max(SCENE_LIMIT_CHARS),
});

const rewriteRecordOpSchema = z.strictObject({
  id: z.string().min(1),
  updatedAt: z.string(),
  content: z.string().max(MAX_L1_CONTENT_CHARS),
});

export const diffSchema = z.strictObject({
  deleteL1: z.array(deleteL1OpSchema).max(MAX_DELETE_L1_OPS).optional(),
  merge: z.array(mergeOpSchema).max(MAX_MERGE_OPS).optional(),
  rewriteBlock: z.array(rewriteBlockOpSchema).max(MAX_REWRITE_OPS).optional(),
  rewriteRecord: z.array(rewriteRecordOpSchema).max(MAX_REWRITE_OPS).optional(),
  rewritePersona: z.string().max(PERSONA_LIMIT_CHARS).optional(),
});

export const applyRequestSchema = z.strictObject({
  diff: diffSchema,
  manifest: z.strictObject({
    baseline: z.record(z.string(), z.string()),
  }),
  context: z.strictObject({
    presentedRecordIds: z.array(z.string()).max(MAX_PRESENTED_IDS),
  }),
});
