/**
 * Zod schemas for all 16 analytics API request bodies.
 *
 * Shared base schemas (timeWindowSchema, paginationSchema) are composed
 * into per-endpoint schemas via .extend() / .merge().
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared base schemas
// ---------------------------------------------------------------------------

/** Time window: days (1/7/30/90) OR from/to ISO range, plus optional space_id. */
export const timeWindowSchema = z.object({
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(7),
  from: z.string().optional(),
  to: z.string().optional(),
  space_id: z.string().optional(),
});
export type TimeWindowParams = z.infer<typeof timeWindowSchema>;

/** Pagination: offset ≥ 0, limit clamped to [1, 200], default 50. */
export const paginationSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z
    .number()
    .int()
    .default(50)
    .transform((v) => Math.max(1, Math.min(200, v))),
  order: z.string().optional(),
});
export type PaginationParams = z.infer<typeof paginationSchema>;

// ---------------------------------------------------------------------------
// Session-init endpoints
// ---------------------------------------------------------------------------

export const sessionInitSummarySchema = timeWindowSchema;
export const sessionInitTimeseriesSchema = timeWindowSchema;
export const bypassReasonsSchema = timeWindowSchema;

// ---------------------------------------------------------------------------
// Tool-call endpoints
// ---------------------------------------------------------------------------

export const toolCallEndpointShareSchema = timeWindowSchema;

export const toolCallTopBodiesSchema = timeWindowSchema.extend({
  top_n: z.number().int().min(1).max(100).default(20),
});

export const toolCallTimeseriesSchema = timeWindowSchema.extend({
  kind: z.enum(["bridge_call", "model_intent"]).optional(),
});

export const toolCallListSchema = timeWindowSchema.merge(paginationSchema).extend({
  kind: z.enum(["bridge_call", "model_intent"]).optional(),
  user_id: z.string().optional(),
  bridge_source: z.string().optional(),
  executed_endpoint: z.string().optional(),
});

export const watermarkSchema = z.object({
  data_cutoff: z.string().optional(),
});

export const detailFetchSchema = z.object({
  data_cutoff: z.string().optional(),
  users: z
    .array(
      z.object({
        user_id: z.string().min(1),
        window_from: z.string().optional(),
        window_to: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
  lookback_days: z.number().int().min(1).max(90).default(30),
});

// ---------------------------------------------------------------------------
// Usage endpoints
// ---------------------------------------------------------------------------

export const usageSummarySchema = timeWindowSchema;
export const usageTimeseriesSchema = timeWindowSchema;
export const usageByModelSchema = timeWindowSchema;

export const usageListSchema = timeWindowSchema.merge(paginationSchema).extend({
  user_id: z.string().optional(),
  model_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Usage-raw endpoint
// ---------------------------------------------------------------------------

export const usageRawListSchema = timeWindowSchema.merge(paginationSchema).extend({
  reason: z
    .enum(["non_tokenhub", "unknown_model", "invalid_format", "invalid_credit", "report_failed"])
    .optional(),
});
