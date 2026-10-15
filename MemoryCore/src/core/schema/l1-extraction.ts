/**
 * Canonical L1 schemas (issue #1210) — domain + structured-output wire.
 *
 * Two explicitly-connected schema layers:
 *
 *   DOMAIN schema (canonical)
 *     ├─ z.infer        → TypeScript types (SceneSegment — no hand-written twin)
 *     ├─ safeParse      → runtime validation (runner tiers, post-repair check)
 *     └─ tests          → import the same objects
 *
 *   WIRE schema (structured-output DTO)
 *     ├─ z.toJSONSchema → provider-native Structured Output JSON Schema
 *     └─ strict-safe    → OpenAI json_schema/strict constraints hold:
 *                         every object closed (additionalProperties:false),
 *                         every property required (optionality expressed as
 *                         nullable unions, not absent-required), no exotic
 *                         keywords (propertyNames/minLength are not portable)
 *
 *   wire → domain decode
 *     The wire layer is deliberately STRICTER than the domain layer in the
 *     three places where the two differ (see comments below). Every
 * wire-valid payload is also domain-valid, so the decode step is the
 * existing tolerant normalization (parseExtractionResult / parseBatchResult)
 * — no second transformation to maintain. Constraints that were dropped from
 * the wire for strict compatibility (non-empty content, record_id) are still
 * enforced by domain validation downstream.
 */

import { z } from "zod";

const L1_MEMORY_TYPE_HINT =
  "persona|episodic|instruction|work_fact|work_task|work_method|work_artifact";

// ============================
// Domain schemas (canonical)
// ============================

export const L1ExtractedMemorySchema = z.strictObject({
  content: z.string().min(1).describe("完整、独立的记忆陈述,无需上下文即可理解"),
  type: z.string().describe(`记忆类型:${L1_MEMORY_TYPE_HINT}`),
  priority: z.number().describe("记忆优先级(整数;instruction 的全局死命令可为 -1)"),
  source_message_ids: z.array(z.string()).describe("该记忆来源的新消息 ID 列表"),
  metadata: z
    .record(z.string(), z.unknown())
    .describe("附加元数据(活动时间/owner/deadline 等;无则输出空对象)"),
});

export const L1SceneSegmentSchema = z.strictObject({
  scene_name: z.string().min(1).describe("当前生成或继承的情境名称(单句,全局唯一)"),
  message_ids: z.array(z.string()).describe("属于该情境的消息 ID 列表"),
  memories: z.array(L1ExtractedMemorySchema).describe("该情境中提取到的核心记忆"),
});

/** Domain wrapper — the canonical wire-adjacent shape. */
export const L1ExtractionSchema = z.strictObject({
  scenes: z.array(L1SceneSegmentSchema).describe("情境切分与记忆提取结果"),
});

/** TypeScript type generated from the canonical domain schema. */
export type SceneSegment = z.infer<typeof L1SceneSegmentSchema>;
export type L1ExtractedMemory = z.infer<typeof L1ExtractedMemorySchema>;

// ============================
// Wire schemas (structured-output DTO, strict-safe)
// ============================

/**
 * Differences vs domain, all in the "wire stricter" direction:
 *   1. no minLength on content/scene_name/record_id — not portable across
 *      strict json_schema implementations; non-empty is re-enforced by
 *      domain validation after parsing.
 *   2. metadata is a CLOSED object with the predefined string fields the
 *      prompts define — strict structured output requires
 *      `additionalProperties: false` on every object, so open maps
 *      (`additionalProperties: {…}`) are not representable. Optionality is
 *      expressed as required+nullable; the parser decode strips null
 *      entries. The domain layer still accepts any Record<string, unknown>.
 */
const L1_WIRE_METADATA_FIELDS = [
  "activity_start_time",
  "activity_end_time",
  "owner",
  "deadline",
  "status",
  "scope",
  "method_type",
  "artifact_type",
  "artifact_ref",
  "work_object",
] as const;

const L1WireMetadataSchema = z.strictObject(
  Object.fromEntries(
    L1_WIRE_METADATA_FIELDS.map((field) => [field, z.string().nullable()]),
  ) as Record<(typeof L1_WIRE_METADATA_FIELDS)[number], z.ZodNullable<z.ZodString>>,
);

const L1WireMemorySchema = z.strictObject({
  content: z.string().describe("完整、独立的记忆陈述(非空,无需上下文即可理解)"),
  type: z.string().describe(`记忆类型:${L1_MEMORY_TYPE_HINT}`),
  priority: z.number().describe("记忆优先级(整数;instruction 的全局死命令可为 -1)"),
  source_message_ids: z.array(z.string()).describe("该记忆来源的新消息 ID 列表"),
  metadata: L1WireMetadataSchema.describe(
    `附加元数据;可用字段:${L1_WIRE_METADATA_FIELDS.join("/")};未使用的字段填 null,无元数据时全部填 null`,
  ),
});

const L1WireSceneSegmentSchema = z.strictObject({
  scene_name: z.string().describe("当前生成或继承的情境名称(单句,全局唯一,非空)"),
  message_ids: z.array(z.string()).describe("属于该情境的消息 ID 列表"),
  memories: z.array(L1WireMemorySchema).describe("该情境中提取到的核心记忆"),
});

export const L1ExtractionWireSchema = z.strictObject({
  scenes: z.array(L1WireSceneSegmentSchema).describe("情境切分与记忆提取结果"),
});

export const L1_EXTRACTION_SCHEMA_NAME = "l1_scene_extraction";

// ============================
// Wire-schema generation (strict-safe)
// ============================

/**
 * Convert a wire zod schema to the JSON Schema sent to providers, applying
 * the one transform needed for strict json_schema compatibility:
 *
 *   strip `propertyNames` — zod emits it for `z.record(string, …)` key
 *   constraints, but strict structured-output implementations (OpenAI) do
 *   not support the keyword. Dropping it only loosens MAP KEY constraints on
 *   the wire; map value types stay constrained, and the domain layer
 *   re-validates keys and values after parsing.
 */
function strictSafeJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  stripPropertyNames(json);
  return json;
}

function stripPropertyNames(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripPropertyNames(item);
    return;
  }
  if (node && typeof node === "object") {
    delete (node as Record<string, unknown>).propertyNames;
    for (const value of Object.values(node as Record<string, unknown>)) {
      stripPropertyNames(value);
    }
  }
}

/**
 * JSON Schema (draft 2020-12) sent on the wire for provider-native
 * Structured Output. Generated once at module load from the wire zod schema —
 * deterministic, and strict-compatibility-audited by tests.
 */
export const L1_EXTRACTION_JSON_SCHEMA: Record<string, unknown> = strictSafeJsonSchema(
  L1ExtractionWireSchema,
);

/**
 * Runtime validation (domain layer). Accepts both the wrapper object and the
 * bare array — the prompts (and therefore json_object / legacy-text tiers)
 * may produce either shape.
 */
export function validateL1ExtractionOutput(value: unknown): boolean {
  if (z.array(L1SceneSegmentSchema).safeParse(value).success) return true;
  return L1ExtractionSchema.safeParse(value).success;
}

// ============================
// L1 dedup / conflict detection — domain
// ============================

/**
 * Domain dedup decision. `merged_*` are optional AND nullable: nullable
 * because the wire layer represents optionality as required+nullable
 * (strict json_schema requires every property in `required`), and the
 * tolerant parser (`parseBatchResult`) already treats non-string values as
 * "not provided", so a wire `null` decodes to an absent field.
 */
export const L1DedupDecisionSchema = z.strictObject({
  record_id: z.string().describe("该决策对应的新记忆 record_id"),
  action: z
    .string()
    .describe("处理动作:store(新增)|update(覆盖)|merge(合并)|skip(忽略)"),
  target_ids: z
    .array(z.string())
    .describe("要删除替换的候选记忆 record_id 列表(store/skip 时可为空)"),
  merged_content: z
    .string()
    .nullable()
    .optional()
    .describe("merge/update 后的记忆内容(merge/update 时必填)"),
  merged_type: z
    .string()
    .nullable()
    .optional()
    .describe(`合并后的最佳 type:${L1_MEMORY_TYPE_HINT}`),
  merged_priority: z
    .number()
    .nullable()
    .optional()
    .describe("merge/update 后的新优先级(0-100 整数)"),
  merged_timestamps: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("合并后保留的时间戳并集(merge/update 时必填)"),
});

export const L1DedupSchema = z.strictObject({
  decisions: z.array(L1DedupDecisionSchema).describe("逐条新记忆的冲突检测决策"),
});

export type L1DedupDecision = z.infer<typeof L1DedupDecisionSchema>;

export const L1_DEDUP_SCHEMA_NAME = "l1_dedup_decisions";

// ============================
// L1 dedup — wire (strict-safe)
// ============================

const L1WireDedupDecisionSchema = z.strictObject({
  record_id: z.string().describe("该决策对应的新记忆 record_id(非空)"),
  action: z
    .string()
    .describe("处理动作:store(新增)|update(覆盖)|merge(合并)|skip(忽略)"),
  target_ids: z
    .array(z.string())
    .describe("要删除替换的候选记忆 record_id 列表(store/skip 时可为空数组)"),
  merged_content: z
    .union([z.string(), z.null()])
    .describe("merge/update 后的记忆内容;store/skip 时输出 null"),
  merged_type: z
    .union([z.string(), z.null()])
    .describe(`合并后的最佳 type:${L1_MEMORY_TYPE_HINT};store/skip 时输出 null`),
  merged_priority: z
    .union([z.number(), z.null()])
    .describe("merge/update 后的新优先级(0-100 整数);store/skip 时输出 null"),
  merged_timestamps: z
    .union([z.array(z.string()), z.null()])
    .describe("合并后保留的时间戳并集;store/skip 时输出 null"),
});

export const L1DedupWireSchema = z.strictObject({
  decisions: z.array(L1WireDedupDecisionSchema).describe("逐条新记忆的冲突检测决策"),
});

export const L1_DEDUP_JSON_SCHEMA: Record<string, unknown> = strictSafeJsonSchema(
  L1DedupWireSchema,
);

export function validateL1DedupOutput(value: unknown): boolean {
  if (z.array(L1DedupDecisionSchema).safeParse(value).success) return true;
  return L1DedupSchema.safeParse(value).success;
}
