/**
 * L1 extraction parser + failure-semantics tests (issue #1210).
 *
 * Pins the tolerant parser layers (unchanged legacy compatibility) and the
 * NEW failure semantics: hard failures (no_json / parse_fail / not_array /
 * normalized_all_dropped / llm_error) return success=false + errorReason,
 * while a legit empty outcome (empty_scenes, valid `[]`) stays success=true.
 *
 * The mock LLMRunner implements ONLY run() — proving that existing runners
 * and mocks are unaffected by the optional structuredOutput field.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractL1Memories,
  parseExtractionResult,
} from "./l1-extractor.js";
import type { LLMRunParams, LLMRunner } from "../types.js";
import {
  L1_EXTRACTION_JSON_SCHEMA,
  L1_EXTRACTION_SCHEMA_NAME,
} from "../schema/l1-extraction.js";

// ============================
// Helpers
// ============================

/** Minimal runner mock — run() only, exactly like existing mock runners. */
function makeRunner(reply: string | ((params: LLMRunParams) => string)): LLMRunner {
  return {
    run: async (params) => (typeof reply === "function" ? reply(params) : reply),
  };
}

function msg(id: string, content: string) {
  return { id, role: "user" as const, content, timestamp: Date.now() };
}

const MESSAGES = [msg("m1", "用户说明天要去北京出差,顺便拜访客户"), msg("m2", "用户要求以后所有回复都用中文")];

const tmpDirs: string[] = [];
async function tmpBaseDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-extractor-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})));
});

const VALID_EXTRACTION = JSON.stringify([
  {
    scene_name: "我在和用户安排出差行程",
    message_ids: ["m1", "m2"],
    memories: [
      {
        content: "用户(小张)明天要去北京出差并拜访客户",
        type: "episodic",
        priority: 80,
        source_message_ids: ["m1"],
        metadata: {},
      },
      {
        content: "用户要求 AI 以后所有回复都用中文",
        type: "instruction",
        priority: 90,
        source_message_ids: ["m2"],
        metadata: {},
      },
    ],
  },
]);

/** A single valid scene segment (one usable memory). */
function sampleScene() {
  return {
    scene_name: "我在和用户安排出差行程",
    message_ids: ["m1"],
    memories: [
      { content: "用户(小张)明天要去北京出差并拜访客户", type: "episodic", priority: 80, source_message_ids: ["m1"], metadata: {} },
    ],
  };
}

// ============================
// parseExtractionResult — tolerant parser layers (legacy compatibility)
// ============================

describe("parseExtractionResult (tolerant parser, unchanged legacy behavior)", () => {
  it("parses a plain JSON array", () => {
    const outcome = parseExtractionResult(VALID_EXTRACTION);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.scenes[0]!.memories).toHaveLength(2);
    expect(outcome.emptyReason).toBeUndefined();
  });

  it("parses a ```json fenced response", () => {
    const outcome = parseExtractionResult("```json\n" + VALID_EXTRACTION + "\n```");
    expect(outcome.scenes).toHaveLength(1);
  });

  it("strips <think>…</think> reasoning before the array match", () => {
    const raw = `<think>用户在讨论行程,可能需要提取 [行程相关] 信息</think>\n${VALID_EXTRACTION}`;
    const outcome = parseExtractionResult(raw);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.scenes[0]!.scene_name).toBe("我在和用户安排出差行程");
  });

  it("F7: unclosed <think> (no </think>) is reasoning-in-progress — hard failure, never salvage JSON from inside think", () => {
    const raw = `<think>让我想想……结构应该是 [{"scene_name":"推理草稿","message_ids":[],"memories":[{"content":"推理里的假记忆","type":"episodic","priority":90,"source_message_ids":[],"metadata":{}}]}] 再检查一下\n`;
    const outcome = parseExtractionResult(raw);
    expect(outcome.scenes).toEqual([]);
    expect(outcome.emptyReason).toBe("unclosed_reasoning");
  });

  it("F7: unclosed think via extractL1Memories → success=false + errorReason (cursor must not advance)", async () => {
    const baseDir = await tmpBaseDir();
    const raw = "<think>模型开始推理但被 max_tokens 截断,没有闭合标签,内容里可能有 [{...";
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("unclosed_reasoning");
  });

  it("F7: a CLOSED think segment followed by an UNCLOSED think containing JSON is still rejected", () => {
    const raw = `<think>第一段推理</think>\n<think>${VALID_EXTRACTION}`;
    expect(parseExtractionResult(raw).emptyReason).toBe("unclosed_reasoning");
  });

  it("N1: a literal '<think>' string inside memory CONTENT is legal and must not be rejected (regression)", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([
      {
        scene_name: "模型排查任务",
        message_ids: ["m1"],
        memories: [
          {
            content: "团队要求排查 reasoning 模型输出的 <think> 标签并保留用户最终响应",
            type: "work_method",
            priority: 70,
            source_message_ids: ["m1"],
            metadata: {},
          },
        ],
      },
    ]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true); // baseline behavior: stored, not rejected
    expect(result.extractedCount).toBe(1);
    expect(result.records[0]!.content).toContain("<think>");
  });

  it("F4: a top-level JSON object without a scenes array (wrong wrapper) is an invalid output", () => {
    expect(parseExtractionResult('{"decisions":[]}').emptyReason).toBe("invalid_output_shape");
    expect(parseExtractionResult('{"result": {"scenes": []}}').emptyReason).toBe("invalid_output_shape");
  });

  it("F4: scene memories/message_ids present but not arrays are structural failures", () => {
    const singleObject = JSON.stringify([
      { scene_name: "s", message_ids: [], memories: { content: "x", type: "episodic", priority: 5, source_message_ids: [], metadata: {} } },
    ]);
    expect(parseExtractionResult(singleObject).emptyReason).toBe("invalid_scene_structure");

    const stringMemories = JSON.stringify([{ scene_name: "s", message_ids: [], memories: "none" }]);
    expect(parseExtractionResult(stringMemories).emptyReason).toBe("invalid_scene_structure");

    const badMessageIds = JSON.stringify([{ scene_name: "s", message_ids: "m1", memories: [] }]);
    expect(parseExtractionResult(badMessageIds).emptyReason).toBe("invalid_scene_structure");
  });

  it("F4: an array of non-object scene entries ([null,1]) is a structural failure", () => {
    expect(parseExtractionResult("[null,1]").emptyReason).toBe("invalid_scene_structure");
  });

  it("R1: array/empty-object scene entries are invalid — never defaulted into pseudo-scenes", () => {
    expect(parseExtractionResult('{"scenes":[[]]}').emptyReason).toBe("invalid_scene_structure");
    expect(parseExtractionResult('{"scenes":[{}]}').emptyReason).toBe("invalid_scene_structure");
    expect(parseExtractionResult('[[]]').emptyReason).toBe("invalid_scene_structure");
  });

  it("R1: an invalid entry mixed with a valid scene keeps the valid content (partial tolerance, no silent skip)", () => {
    const raw = JSON.stringify([[], sampleScene()]);
    const outcome = parseExtractionResult(raw);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.scenes[0]!.memories).toHaveLength(1);
    expect(outcome.emptyReason).toBeUndefined();
  });

  it("R1 end-to-end: {\"scenes\":[[]]} must NOT advance the checkpoint", async () => {
    const baseDir = await tmpBaseDir();
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner('{"scenes":[[]]}') },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("invalid_scene_structure");
  });

  it("R4: a PAIRED think literal inside memory content survives verbatim (baseline corruption fixed)", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([
      {
        scene_name: "配置约定",
        message_ids: ["m1"],
        memories: [
          {
            content: "团队要求将配置字符串 <think>reasoning=false</think> 原样保存",
            type: "work_method",
            priority: 70,
            source_message_ids: ["m1"],
            metadata: {},
          },
        ],
      },
    ]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true);
    expect(result.records[0]!.content).toBe("团队要求将配置字符串 <think>reasoning=false</think> 原样保存");
  });

  it("R4: a wrapper think block before the payload is still excluded", () => {
    const raw = `<think>内部讨论,含杂散 [ 括号</think>\n${JSON.stringify([sampleScene()])}`;
    const outcome = parseExtractionResult(raw);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.emptyReason).toBeUndefined();
  });

  it("② : a TRAILING closed think block containing brackets must not extend/corrupt the payload", async () => {
    const baseDir = await tmpBaseDir();
    const raw = `${JSON.stringify([sampleScene()])}\n<think>最终校验对象 {debug:[1]}</think>`;
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true); // baseline behavior: parsed and stored
    expect(result.extractedCount).toBe(1);

    // Wrapper-object form with a trailing think block, too.
    const wrapped = `{"scenes":${JSON.stringify([sampleScene()])}}\n<think>复核 {"x":[1]}</think>`;
    const wrappedResult = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(wrapped) },
    });
    expect(wrappedResult.success).toBe(true);
    expect(wrappedResult.extractedCount).toBe(1);
  });

  it("F4: empty scene_name with empty memories is NOT a legitimate empty — canonical validation fails it", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([{ scene_name: "", message_ids: [], memories: [] }]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("canonical_validation_failed");
  });

  it("F4: the canonical gate applies to zero-memory outcomes too — structurally-valid empty stays a success", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([{ scene_name: "闲聊", message_ids: ["m1"], memories: [] }]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true);
  });

  it("F1 decode: wire metadata null fields are stripped, real values are kept", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([
      {
        scene_name: "行程",
        message_ids: ["m1"],
        memories: [
          {
            content: "用户明天要去北京出差",
            type: "episodic",
            priority: 80,
            source_message_ids: ["m1"],
            metadata: { activity_start_time: "2026-10-01T00:00:00Z", owner: null, deadline: null },
          },
        ],
      },
    ]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true);
    expect(result.records[0]!.metadata).toEqual({ activity_start_time: "2026-10-01T00:00:00Z" });
  });

  it("F2: memories offered but ALL structurally unusable → success=false (invalid_memories_dropped), not legit empty", async () => {
    const baseDir = await tmpBaseDir();
    const cases: Array<Array<unknown>> = [
      [{ content: "", type: "episodic", priority: 50, source_message_ids: [], metadata: {} }], // empty content
      [{ type: "episodic", priority: 50, source_message_ids: [], metadata: {} }], // missing content
      [{ content: 42, type: "episodic", priority: 50, source_message_ids: [], metadata: {} }], // non-string content
      ["just a string, not an object"], // non-object memory element
    ];
    for (const memories of cases) {
      const raw = JSON.stringify([{ scene_name: "场景", message_ids: ["m1"], memories }]);
      const result = await extractL1Memories({
        messages: MESSAGES,
        sessionKey: "s-test",
        baseDir,
        config: {},
        options: { enableDedup: false, llmRunner: makeRunner(raw) },
      });
      expect(result.success, `memories=${JSON.stringify(memories).slice(0, 60)}`).toBe(false);
      expect(result.errorReason).toBe("invalid_memories_dropped");
    }
  });

  it("F2: partial drop keeps the valid memories (tolerant behavior unchanged)", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([
      {
        scene_name: "混合场景",
        message_ids: ["m1"],
        memories: [
          { content: "", type: "episodic", priority: 50, source_message_ids: [], metadata: {} }, // dropped
          { content: "用户明天要去北京出差", type: "episodic", priority: 80, source_message_ids: ["m1"], metadata: {} }, // kept
        ],
      },
    ]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);
  });

  it("repairs a raw control character inside a JSON string", () => {
    const broken = `[{\"scene_name\":\"行程\n换行\",\"message_ids\":[],\"memories\":[]}]`;
    const outcome = parseExtractionResult(broken);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.scenes[0]!.scene_name).toBe("行程\n换行");
  });

  it("repairs trailing commas and bare priority identifiers", () => {
    const broken =
      `[{\"scene_name\":\"行程\",\"message_ids\":[],\"memories\":[` +
      `{\"content\":\"用户明天出差\",\"type\":\"episodic\",\"priority\":sheet,\"source_message_ids\":[],\"metadata\":{}}` +
      `],}]`;
    const outcome = parseExtractionResult(broken);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.scenes[0]!.memories[0]!.priority).toBe(50);
  });

  it("keeps memories whose content contains quotes, markdown and code fences", () => {
    const raw = JSON.stringify([
      {
        scene_name: "代码讨论",
        message_ids: ["m1"],
        memories: [
          {
            content: '用户说"用 `npm test`"并贴了 ```bash\nnpm run build\n``` 片段',
            type: "work_method",
            priority: 70,
            source_message_ids: ["m1"],
            metadata: {},
          },
        ],
      },
    ]);
    const outcome = parseExtractionResult(raw);
    expect(outcome.scenes[0]!.memories[0]!.content).toContain("npm test");
  });

  it("classifies no_json when no JSON array is present", () => {
    expect(parseExtractionResult("抱歉,我无法完成这个任务").emptyReason).toBe("no_json");
  });

  it("classifies parse_fail for unrepairable JSON", () => {
    expect(parseExtractionResult(`[{\"scene_name\" \"missing colon\"}]`).emptyReason).toBe("parse_fail");
  });

  it("classifies empty_scenes for a valid empty array", () => {
    expect(parseExtractionResult("[]").emptyReason).toBe("empty_scenes");
  });

  it("accepts the structured-output wrapper {scenes:[…]} (tier-1 wire shape)", () => {
    const wrapped = JSON.stringify({ scenes: JSON.parse(VALID_EXTRACTION) });
    const outcome = parseExtractionResult(wrapped);
    expect(outcome.scenes).toHaveLength(1);
    expect(outcome.scenes[0]!.memories).toHaveLength(2);
  });
});

// ============================
// extractL1Memories — failure semantics (issue #1210)
// ============================

describe("extractL1Memories failure semantics", () => {
  it("success=true for a valid extraction (dedup disabled)", async () => {
    const baseDir = await tmpBaseDir();
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(VALID_EXTRACTION) },
    });
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(2);
    expect(result.errorReason).toBeUndefined();
  });

  it("success=true for a legit empty outcome (valid [])", async () => {
    const baseDir = await tmpBaseDir();
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner("[]") },
    });
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(0);
    expect(result.errorReason).toBeUndefined();
  });

  it("success=true for scenes with empty memories arrays", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([{ scene_name: "闲聊", message_ids: ["m1"], memories: [] }]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true);
    expect(result.sceneNames).toEqual(["闲聊"]);
  });

  it("success=false + errorReason=no_json when the model output has no JSON", async () => {
    const baseDir = await tmpBaseDir();
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner("模型拒绝输出 JSON,直接聊了起来") },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("no_json");
  });

  it("success=false + errorReason=parse_fail for unrepairable JSON", async () => {
    const baseDir = await tmpBaseDir();
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(`[{\"scene_name\" \"broken\"}]`) },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("parse_fail");
  });

  it("success=false + errorReason=normalized_all_dropped when every memory has an invalid type", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([
      {
        scene_name: "混合场景",
        message_ids: ["m1"],
        memories: [
          { content: "记忆一", type: "bogus_type", priority: 60, source_message_ids: [], metadata: {} },
          { content: "记忆二", type: "also_bogus", priority: 70, source_message_ids: [], metadata: {} },
        ],
      },
    ]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("normalized_all_dropped");
  });

  it("success=false + errorReason=llm_error when the runner throws", async () => {
    const baseDir = await tmpBaseDir();
    const throwingRunner: LLMRunner = {
      run: async () => {
        throw new Error("upstream 503");
      },
    };
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: throwingRunner },
    });
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("llm_error");
  });

  it("passes structuredOutput (canonical wire schema) to the runner", async () => {
    const baseDir = await tmpBaseDir();
    let captured: LLMRunParams | undefined;
    const capturingRunner: LLMRunner = {
      run: async (params) => {
        captured = params;
        return VALID_EXTRACTION;
      },
    };
    await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: capturingRunner },
    });
    expect(captured?.structuredOutput?.schema).toBe(L1_EXTRACTION_JSON_SCHEMA);
    expect(captured?.structuredOutput?.schemaName).toBe(L1_EXTRACTION_SCHEMA_NAME);
    expect(typeof captured?.structuredOutput?.validate).toBe("function");
    expect(captured?.structuredOutput?.validate?.(JSON.parse(VALID_EXTRACTION))).toBe(true);
  });

  it("normalizes legacy type aliases and non-number priority (existing tolerant behavior)", async () => {
    const baseDir = await tmpBaseDir();
    const raw = JSON.stringify([
      {
        scene_name: "别名场景",
        message_ids: ["m1"],
        memories: [
          { content: "用户喜欢简洁的回复", type: "preference", priority: "high", source_message_ids: [], metadata: {} },
        ],
      },
    ]);
    const result = await extractL1Memories({
      messages: MESSAGES,
      sessionKey: "s-test",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner: makeRunner(raw) },
    });
    expect(result.success).toBe(true);
    expect(result.records[0]!.type).toBe("persona"); // preference → persona alias
    expect(result.records[0]!.priority).toBe(50); // non-number → default
  });
});
