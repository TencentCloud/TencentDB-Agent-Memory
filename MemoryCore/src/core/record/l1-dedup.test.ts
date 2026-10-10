/**
 * Dedup parser tests (issue #1210 review R4).
 *
 * parseBatchResult must locate the decisions array among text OUTSIDE closed
 * <think> spans and slice the ORIGINAL raw text — literal think tags inside
 * merged_content survive verbatim, while wrapper reasoning (and its stray
 * brackets) stays excluded.
 */

import { describe, expect, it } from "vitest";
import { parseBatchResult } from "./l1-dedup.js";
import type { ExtractedMemory } from "./l1-writer.js";

const MEMORIES: Array<ExtractedMemory & { record_id: string }> = [
  { content: "新记忆一", type: "episodic", priority: 80, source_message_ids: [], metadata: {}, scene_name: "场景", record_id: "rec-1" },
  { content: "新记忆二", type: "persona", priority: 70, source_message_ids: [], metadata: {}, scene_name: "场景", record_id: "rec-2" },
];

describe("parseBatchResult (reasoning-wrapper-aware, review R4)", () => {
  it("parses a bare decisions array", () => {
    const raw = JSON.stringify([
      { record_id: "rec-1", action: "store", target_ids: [] },
      { record_id: "rec-2", action: "skip", target_ids: [] },
    ]);
    const decisions = parseBatchResult(raw, MEMORIES);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ record_id: "rec-1", action: "store" });
  });

  it("keeps a PAIRED think literal inside merged_content verbatim", () => {
    const raw = JSON.stringify([
      {
        record_id: "rec-1",
        action: "merge",
        target_ids: ["rec-old-1"],
        merged_content: "团队要求将配置字符串 <think>reasoning=false</think> 原样保存",
        merged_type: "work_method",
        merged_priority: 85,
        merged_timestamps: [],
      },
    ]);
    const decisions = parseBatchResult(raw, MEMORIES);
    expect(decisions[0]!.merged_content).toBe(
      "团队要求将配置字符串 <think>reasoning=false</think> 原样保存",
    );
  });

  it("excludes wrapper reasoning before the decisions array (stray brackets included)", () => {
    const decisions = JSON.stringify([
      { record_id: "rec-1", action: "store", target_ids: [] },
      { record_id: "rec-2", action: "store", target_ids: [] },
    ]);
    const raw = `<think>候选 [rec_a1] 和 [rec_b2] 相似,但输出还应符合 [\"record_id\"...]</think>\n${decisions}`;
    const parsed = parseBatchResult(raw, MEMORIES);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ record_id: "rec-1", action: "store" });
  });

  it("② : a TRAILING closed think block with brackets must not degrade a valid skip decision", () => {
    const decisions = JSON.stringify([
      { record_id: "rec-1", action: "skip", target_ids: [] },
      { record_id: "rec-2", action: "store", target_ids: [] },
    ]);
    const raw = `${decisions}\n<think>最终校验对象 {debug:[1]}</think>`;
    const parsed = parseBatchResult(raw, MEMORIES);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ record_id: "rec-1", action: "skip" }); // judgment preserved, not store-all
  });

  it("falls back to store-all on an unclosed think wrapper", () => {
    const raw = "<think>推理未闭合 [ {\"record_id\": \"rec-1\"...";
    const parsed = parseBatchResult(raw, MEMORIES);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((d) => d.action === "store")).toBe(true);
  });

  it("falls back to store-all when no decisions array exists", () => {
    const parsed = parseBatchResult("抱歉,无法判断", MEMORIES);
    expect(parsed.every((d) => d.action === "store")).toBe(true);
  });
});
