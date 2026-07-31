import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner, Logger } from "../types.js";
import type { ExtractedMemory } from "./l1-writer.js";
import { validateLlmMemory } from "./l1-confidence.js";
import { extractL1Memories } from "./l1-extractor.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("validateLlmMemory", () => {
  const source = [
    message("m1", "user", "我是后端工程师，主要使用 TypeScript 和 PostgreSQL。"),
    message("m2", "user", "Please always answer release questions in concise English."),
  ];

  it("accepts traceable persona and instruction memories", () => {
    expect(validateLlmMemory(
      memory("用户是后端工程师，主要使用 TypeScript 和 PostgreSQL", "persona", ["m1"]),
      source,
    )).toEqual({ accepted: true });

    expect(validateLlmMemory(
      memory("The user requires the AI to always answer release questions in concise English.", "instruction", ["m2"]),
      source,
    )).toEqual({ accepted: true });
  });

  it("falls back to the new-message window when source ids are omitted", () => {
    expect(validateLlmMemory(
      memory("用户主要使用 TypeScript 开发后端服务", "persona", []),
      source,
    )).toEqual({ accepted: true });
  });

  it("accepts concise paraphrases instead of requiring verbatim copying", () => {
    expect(validateLlmMemory(
      memory(
        "The user requires the AI to always answer release questions concisely in English.",
        "instruction",
        ["m2"],
      ),
      source,
    )).toEqual({ accepted: true });
  });

  it("rejects unknown source ids and zero-overlap hallucinations", () => {
    expect(validateLlmMemory(
      memory("用户是后端工程师", "persona", ["not-in-prompt"]),
      source,
    )).toEqual({ accepted: false, reason: "unknown-source-message-id" });
    expect(validateLlmMemory(
      memory("用户是后端工程师", "persona", ["m1", "m2"]),
      [
        source[0],
        message("m2", "assistant", "用户是后端工程师"),
      ],
    )).toEqual({ accepted: false, reason: "unknown-source-message-id" });

    expect(validateLlmMemory(
      memory("用户是后端工程师，长期居住在柏林并经营一家咖啡馆", "persona", ["m1"]),
      source,
    )).toEqual({ accepted: false, reason: "no-evidence-overlap" });
  });

  it("rejects clearly short or type-inconsistent outputs", () => {
    expect(validateLlmMemory(memory("好的", "episodic", ["m1"]), source))
      .toEqual({ accepted: false, reason: "content-too-short" });
    expect(validateLlmMemory(memory("后端工程师，熟悉 TypeScript", "persona", ["m1"]), source))
      .toEqual({ accepted: false, reason: "persona-missing-user-anchor" });
    expect(validateLlmMemory(memory("中文回复", "instruction", ["m2"]), source))
      .toEqual({ accepted: false, reason: "instruction-missing-directive-shape" });
  });

  it("rejects trivial episodic boilerplate", () => {
    expect(validateLlmMemory(
      memory("用户询问了关于 PostgreSQL 的问题", "episodic", ["m1"]),
      source,
    )).toEqual({ accepted: false, reason: "episodic-trivial-boilerplate" });
  });
});

describe("extractL1Memories confidence integration", () => {
  it("stores traceable memories and drops hallucinated LLM output with a reason", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-confidence-"));
    tempDirs.push(dataDir);
    const debug = vi.fn();
    const logger: Logger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runner: LLMRunner = {
      async run() {
        return JSON.stringify([{
          scene_name: "开发偏好",
          message_ids: ["m1"],
          memories: [
            {
              content: "用户主要使用 TypeScript 开发后端服务",
              type: "persona",
              priority: 80,
              source_message_ids: ["m1"],
              metadata: {},
            },
            {
              content: "用户是后端工程师，长期居住在柏林并经营一家咖啡馆",
              type: "persona",
              priority: 90,
              source_message_ids: ["m1"],
              metadata: {},
            },
          ],
        }]);
      },
    };

    const result = await extractL1Memories({
      messages: [message("m1", "user", "我主要使用 TypeScript 开发后端服务，请记录这个技术偏好。")],
      sessionKey: "confidence-test",
      baseDir: dataDir,
      config: {},
      options: { enableDedup: false, llmRunner: runner },
      logger,
    });

    expect(result.records.map((record) => record.content)).toEqual([
      "用户主要使用 TypeScript 开发后端服务",
    ]);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("reason=no-evidence-overlap"),
    );
  });
});

function message(
  id: string,
  role: ConversationMessage["role"],
  content: string,
): ConversationMessage {
  return { id, role, content, timestamp: Date.now() };
}

function memory(
  content: string,
  type: ExtractedMemory["type"],
  sourceMessageIds: string[],
): ExtractedMemory {
  return {
    content,
    type,
    priority: 80,
    source_message_ids: sourceMessageIds,
    metadata: {},
    scene_name: "test",
  };
}
