import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner } from "../types.js";
import { extractL1Memories } from "./l1-extractor.js";
import { preExtractHighConfidence } from "./pre-extractor.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("preExtractHighConfidence", () => {
  it("extracts explicit user facts but never assistant messages", () => {
    const input = [
      message("u1", "user", "我是后端工程师"),
      message("a1", "assistant", "我是前端工程师"),
      message("u2", "user", "请用中文回复我"),
    ];

    const result = preExtractHighConfidence(input);

    expect(result.direct.map((memory) => [memory.type, memory.content])).toEqual([
      ["persona", "用户是后端工程师"],
      ["instruction", "用户要求 AI 使用中文回复"],
    ]);
    expect(result.remainingMessages).toEqual([input[1]]);
  });

  it("leaves ambiguous or contextual messages in the LLM path", () => {
    const input = [
      message("u1", "user", "我觉得这个方案可能不错，但还需要比较两个数据库"),
      message("u2", "user", "下周部署 Atlas 项目"),
    ];

    expect(preExtractHighConfidence(input)).toEqual({
      direct: [],
      remainingMessages: input,
    });
  });
});

describe("extractL1Memories pre-extraction integration", () => {
  it("never pre-extracts background messages", async () => {
    const runner: LLMRunner = {
      run: vi.fn(async () => "[]"),
    };

    await runExtraction(
      [
        message("old", "user", "我是机密背景身份"),
        message("new", "user", "请分析这个方案并列出风险"),
      ],
      runner,
      { maxMessagesPerExtraction: 1 },
    );

    expect(runner.run).toHaveBeenCalledOnce();
    const prompt = vi.mocked(runner.run).mock.calls[0][0].prompt;
    expect(prompt).toContain("我是机密背景身份");
    expect(prompt).toContain("请分析这个方案并列出风险");
  });

  it("skips the LLM when all new user messages are deterministic", async () => {
    const runner: LLMRunner = {
      run: vi.fn(async () => {
        throw new Error("LLM must not be called");
      }),
    };

    const result = await runExtraction(
      [
        message("u1", "user", "以后都使用简洁的项目进度格式"),
        message("a1", "assistant", "明白，我会保持简洁。"),
      ],
      runner,
    );

    expect(runner.run).not.toHaveBeenCalled();
    expect(result.records.map((record) => record.content)).toEqual([
      "用户要求 AI 以后使用简洁的项目进度格式",
    ]);
  });

  it("merges direct memories with LLM results without sending matched text to the LLM", async () => {
    const runner: LLMRunner = {
      run: vi.fn(async () => JSON.stringify([
        {
          scene_name: "项目规划",
          message_ids: ["u2"],
          memories: [{
            content: "用户计划下周部署 Atlas 项目",
            type: "episodic",
            priority: 80,
            source_message_ids: ["u2"],
            metadata: {},
          }],
        },
      ])),
    };

    const result = await runExtraction(
      [
        message("u1", "user", "我是后端工程师"),
        message("u2", "user", "请帮我规划下周部署 Atlas 项目的步骤和风险"),
      ],
      runner,
    );

    const prompt = vi.mocked(runner.run).mock.calls[0][0].prompt;
    expect(prompt).not.toContain("我是后端工程师");
    expect(prompt).toContain("请帮我规划下周部署 Atlas 项目的步骤和风险");
    expect(result.records.map((record) => record.content)).toEqual([
      "用户是后端工程师",
      "用户计划下周部署 Atlas 项目",
    ]);
  });
});

function message(
  id: string,
  role: ConversationMessage["role"],
  content: string,
): ConversationMessage {
  return { id, role, content, timestamp: Date.now() };
}

async function runExtraction(
  messages: ConversationMessage[],
  llmRunner: LLMRunner,
  extraOptions: { maxMessagesPerExtraction?: number } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-pre-extract-"));
  tempDirs.push(dataDir);

  return extractL1Memories({
    messages,
    sessionKey: "pre-extraction-test",
    baseDir: dataDir,
    config: {},
    options: {
      enableDedup: false,
      llmRunner,
      ...extraOptions,
    },
  });
}
