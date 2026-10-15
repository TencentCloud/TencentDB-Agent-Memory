/**
 * Canonical L1 schema tests (issue #1210, review round 2).
 *
 * Anchors:
 *   - domain schemas validate real payloads (wrapper + bare array) and
 *     reject structurally invalid ones
 *   - WIRE schemas are strict-compatible: every object closed
 *     (additionalProperties:false), every property required, no exotic
 *     keywords (propertyNames/minLength) — audited on the REAL generated
 *     JSON Schema, not on assumptions
 *   - wire ⊆ domain: every wire-valid payload passes domain validation
 *     (the decode contract), property sets stay aligned
 */

import { describe, expect, it } from "vitest";
import {
  L1_DEDUP_JSON_SCHEMA,
  L1_EXTRACTION_JSON_SCHEMA,
  L1ExtractionSchema,
  L1ExtractionWireSchema,
  L1DedupDecisionSchema,
  L1DedupWireSchema,
  validateL1DedupOutput,
  validateL1ExtractionOutput,
  type L1DedupDecision,
  type SceneSegment,
} from "./l1-extraction.js";

// ============================
// Shared strict-schema audit (walks the REAL generated JSON Schema)
// ============================

/**
 * Recursively assert OpenAI-strict compatibility of a generated JSON Schema.
 * Audits EVERY object node — including propertyless ones (an open map like
 * `additionalProperties: {…}` has no `properties` and must still be flagged).
 */
function expectStrictCompatible(root: Record<string, unknown>, label: string) {
  const problems: string[] = [];
  const walk = (node: unknown, p: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("propertyNames" in obj) problems.push(`${p}: "propertyNames" is not portable in strict mode`);
    if ("minLength" in obj || "maxLength" in obj) problems.push(`${p}: string length keywords are not portable`);
    if (obj.type === "object") {
      if (obj.additionalProperties !== false) {
        problems.push(`${p}: additionalProperties !== false (got ${JSON.stringify(obj.additionalProperties)})`);
      }
      if (obj.properties) {
        const required = new Set((obj.required as string[] | undefined) ?? []);
        for (const key of Object.keys(obj.properties)) {
          if (!required.has(key)) problems.push(`${p}.${key}: not in required (strict requires all)`);
        }
      }
    }
    for (const [key, value] of Object.entries(obj)) walk(value, `${p}.${key}`);
  };
  walk(root, "$");
  expect(problems, `${label} strict-compatibility problems:\n${problems.join("\n")}`).toEqual([]);
}

// Sample aligned with the prompt's output-format example (chat mode).
const sampleSegment: SceneSegment = {
  scene_name: "我在和产品经理讨论旅行计划",
  message_ids: ["msg-1", "msg-2"],
  memories: [
    {
      content: "用户(小明)计划在 2026 年 10 月去日本旅行",
      type: "episodic",
      priority: 85,
      source_message_ids: ["msg-1"],
      metadata: {
        activity_start_time: "2026-10-01T00:00:00Z",
        activity_end_time: "2026-10-08T00:00:00Z",
      },
    },
    {
      content: "用户要求 AI 以后只用中文回复",
      type: "instruction",
      priority: 90,
      source_message_ids: ["msg-2"],
      metadata: {},
    },
  ],
};

describe("L1ExtractionSchema (domain, canonical)", () => {
  it("accepts a valid wrapped payload", () => {
    expect(L1ExtractionSchema.safeParse({ scenes: [sampleSegment] }).success).toBe(true);
  });

  it("accepts a scene segment with an empty memories array (legit no-memory outcome)", () => {
    expect(
      L1ExtractionSchema.safeParse({
        scenes: [{ scene_name: "闲聊", message_ids: ["msg-1"], memories: [] }],
      }).success,
    ).toBe(true);
  });

  it("accepts non-string metadata values (domain is wider than wire)", () => {
    const segment = structuredClone(sampleSegment);
    segment.memories[0].metadata = { count: 3, nested: { ok: true } };
    expect(L1ExtractionSchema.safeParse({ scenes: [segment] }).success).toBe(true);
  });

  it("rejects a memory missing content / empty content / non-number priority", () => {
    const noContent = structuredClone(sampleSegment);
    delete (noContent.memories[0] as Partial<SceneSegment["memories"][number]>).content;
    expect(L1ExtractionSchema.safeParse({ scenes: [noContent] }).success).toBe(false);

    const emptyContent = structuredClone(sampleSegment);
    emptyContent.memories[0].content = "";
    expect(L1ExtractionSchema.safeParse({ scenes: [emptyContent] }).success).toBe(false);

    const badPriority = structuredClone(sampleSegment);
    (badPriority.memories[0] as Record<string, unknown>).priority = "high";
    expect(L1ExtractionSchema.safeParse({ scenes: [badPriority] }).success).toBe(false);
  });

  it("rejects non-array message_ids", () => {
    const bad = structuredClone(sampleSegment);
    (bad as Record<string, unknown>).message_ids = "msg-1";
    expect(L1ExtractionSchema.safeParse({ scenes: [bad] }).success).toBe(false);
  });

  it("validateL1ExtractionOutput accepts both the wrapper and the bare array", () => {
    expect(validateL1ExtractionOutput({ scenes: [sampleSegment] })).toBe(true);
    expect(validateL1ExtractionOutput([sampleSegment])).toBe(true);
    expect(validateL1ExtractionOutput([])).toBe(true); // legit empty scene list
  });

  it("validateL1ExtractionOutput rejects malformed payloads", () => {
    expect(validateL1ExtractionOutput({ scenes: "nope" })).toBe(false);
    expect(validateL1ExtractionOutput({})).toBe(false);
    expect(validateL1ExtractionOutput(null)).toBe(false);
  });
});

describe("L1_EXTRACTION_JSON_SCHEMA (wire) — strict compatibility (F1)", () => {
  it("REAL generated schema is strict-compatible", () => {
    expectStrictCompatible(L1_EXTRACTION_JSON_SCHEMA, "L1_EXTRACTION_JSON_SCHEMA");
  });

  it("has an object root with a required scenes array", () => {
    expect(L1_EXTRACTION_JSON_SCHEMA.type).toBe("object");
    expect(L1_EXTRACTION_JSON_SCHEMA.required).toEqual(["scenes"]);
    expect((L1_EXTRACTION_JSON_SCHEMA.properties as Record<string, { type: string }>).scenes.type).toBe("array");
  });

  it("metadata is a CLOSED object on the wire: predefined fields, required+nullable (F1)", () => {
    const scene = (L1_EXTRACTION_JSON_SCHEMA.properties as Record<string, { items: Record<string, unknown> }>)
      .scenes.items as Record<string, unknown>;
    const memory = ((scene.properties as Record<string, { items: Record<string, unknown> }>).memories as { items: Record<string, unknown> }).items;
    const metadata = (memory.properties as Record<string, Record<string, unknown>>).metadata;
    expect(metadata.type).toBe("object");
    expect(metadata.additionalProperties).toBe(false);
    expect(metadata.propertyNames).toBeUndefined();
    const fields = Object.keys(metadata.properties as Record<string, unknown>);
    expect(fields).toEqual(
      expect.arrayContaining(["activity_start_time", "owner", "deadline", "status", "scope", "method_type", "artifact_type", "artifact_ref", "work_object"]),
    );
    expect(metadata.required).toEqual(fields); // optionality = required + nullable
    const field = (metadata.properties as Record<string, { type: unknown }>)[fields[0]!]!;
    expect(field.type).toEqual(["string", "null"]);
  });

  it("wire→domain boundary is exact: wire-valid strings pass domain; empty strings are rejected by domain (not wire)", () => {
    // The two layers differ ONLY in constraints the wire cannot express
    // portably (non-emptiness). Every wire-valid payload with non-empty
    // strings is domain-valid (the decode contract); wire-valid-but-empty
    // content is caught by domain validation after parsing.
    const wireValid = {
      scenes: [
        {
          scene_name: "行程讨论",
          message_ids: ["m1"],
          memories: [
            {
              content: "用户明天出差",
              type: "episodic",
              priority: 80,
              source_message_ids: ["m1"],
              metadata: { activity_start_time: "2026-10-01", owner: null, deadline: null, status: null, scope: null, method_type: null, artifact_type: null, artifact_ref: null, work_object: null, activity_end_time: null },
            },
          ],
        },
      ],
    };
    expect(L1ExtractionWireSchema.safeParse(wireValid).success).toBe(true);
    expect(L1ExtractionSchema.safeParse(wireValid).success).toBe(true); // wire-null metadata values are domain-valid (unknown)

    const emptyContent = structuredClone(wireValid);
    emptyContent.scenes[0]!.memories[0]!.content = "";
    expect(L1ExtractionWireSchema.safeParse(emptyContent).success).toBe(true); // wire cannot express minLength
    expect(L1ExtractionSchema.safeParse(emptyContent).success).toBe(false); // domain enforces non-empty post-parse
  });
});

describe("L1DedupDecisionSchema (domain, canonical)", () => {
  it("accepts a full merge decision", () => {
    const decision: L1DedupDecision = {
      record_id: "rec-1",
      action: "merge",
      target_ids: ["rec-old-1", "rec-old-2"],
      merged_content: "合并后的记忆内容",
      merged_type: "episodic",
      merged_priority: 85,
      merged_timestamps: ["2026-01-01", "2026-02-01"],
    };
    expect(L1DedupDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("accepts a minimal store decision (merged_* absent) AND wire-shaped nulls", () => {
    expect(L1DedupDecisionSchema.safeParse({ record_id: "rec-2", action: "store", target_ids: [] }).success).toBe(true);
    // wire represents optionality as required+nullable; domain must decode it
    expect(
      L1DedupDecisionSchema.safeParse({
        record_id: "rec-2",
        action: "store",
        target_ids: [],
        merged_content: null,
        merged_type: null,
        merged_priority: null,
        merged_timestamps: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a decision missing record_id", () => {
    expect(L1DedupDecisionSchema.safeParse({ action: "store", target_ids: [] }).success).toBe(false);
  });

  it("validateL1DedupOutput accepts wrapper, bare array, and null-bearing wire shapes", () => {
    expect(validateL1DedupOutput({ decisions: [{ record_id: "r", action: "skip", target_ids: [] }] })).toBe(true);
    expect(validateL1DedupOutput([{ record_id: "r", action: "skip", target_ids: [] }])).toBe(true);
    expect(
      validateL1DedupOutput({ decisions: [{ record_id: "r", action: "store", target_ids: [], merged_content: null }] }),
    ).toBe(true);
    expect(validateL1DedupOutput({ decisions: [{ action: "skip" }] })).toBe(false);
  });
});

describe("L1_DEDUP_JSON_SCHEMA (wire) — strict compatibility (F1)", () => {
  it("REAL generated schema is strict-compatible (optionality as required+nullable)", () => {
    expectStrictCompatible(L1_DEDUP_JSON_SCHEMA, "L1_DEDUP_JSON_SCHEMA");
    const decision = (L1_DEDUP_JSON_SCHEMA.properties as Record<string, { items: Record<string, unknown> }>)
      .decisions.items as Record<string, unknown>;
    expect(decision.required).toEqual([
      "record_id",
      "action",
      "target_ids",
      "merged_content",
      "merged_type",
      "merged_priority",
      "merged_timestamps",
    ]);
  });

  it("wire ⊆ domain: wire-valid decision (null merged_*) passes domain validation", () => {
    const wireDecision = {
      record_id: "r1",
      action: "merge",
      target_ids: [],
      merged_content: "文本",
      merged_type: null,
      merged_priority: 85,
      merged_timestamps: null,
    };
    expect(L1DedupWireSchema.safeParse({ decisions: [wireDecision] }).success).toBe(true);
    expect(L1DedupDecisionSchema.safeParse(wireDecision).success).toBe(true);
  });
});
