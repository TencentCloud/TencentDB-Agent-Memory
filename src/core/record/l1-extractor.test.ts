import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

describe("extractL1Memories rule pre-extraction", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-pre-extract-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores explicit persona statements without calling the LLM", async () => {
    const llmRunner: LLMRunner = {
      run: vi.fn(async () => {
        throw new Error("LLM should not be called for high-confidence persona statements");
      }),
    };

    const result = await extractL1Memories({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "我是 Python 工程师",
          timestamp: Date.parse("2026-06-01T10:00:00Z"),
        },
      ],
      sessionKey: "session-pre-extract",
      baseDir: tmpDir,
      config: {},
      options: {
        enableDedup: false,
        llmRunner,
      },
    });

    expect(llmRunner.run).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      content: "用户是 Python 工程师。",
      type: "persona",
      priority: 80,
      source_message_ids: ["msg-1"],
    });
  });

  it("stores explicit reply instructions without calling the LLM", async () => {
    const llmRunner: LLMRunner = {
      run: vi.fn(async () => {
        throw new Error("LLM should not be called for high-confidence instructions");
      }),
    };

    const result = await extractL1Memories({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "以后请用中文回复",
          timestamp: Date.parse("2026-06-01T10:00:00Z"),
        },
      ],
      sessionKey: "session-pre-extract",
      baseDir: tmpDir,
      config: {},
      options: {
        enableDedup: false,
        llmRunner,
      },
    });

    expect(llmRunner.run).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      content: "用户要求 AI 以后用中文回复。",
      type: "instruction",
      priority: 80,
      source_message_ids: ["msg-1"],
    });
  });

  it("keeps using the LLM when any user message is not covered by direct rules", async () => {
    const llmRunner: LLMRunner = {
      run: vi.fn(async () => JSON.stringify([
        {
          scene_name: "用户讨论复杂计划",
          message_ids: ["msg-1", "msg-2"],
          memories: [
            {
              content: "用户正在评估一项复杂迁移计划。",
              type: "episodic",
              priority: 70,
              source_message_ids: ["msg-2"],
              metadata: {},
            },
          ],
        },
      ])),
    };

    const result = await extractL1Memories({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "我是 Python 工程师",
          timestamp: Date.parse("2026-06-01T10:00:00Z"),
        },
        {
          id: "msg-2",
          role: "user",
          content: "我们今天需要讨论数据库迁移的灰度计划和失败回滚策略。",
          timestamp: Date.parse("2026-06-01T10:01:00Z"),
        },
      ],
      sessionKey: "session-pre-extract",
      baseDir: tmpDir,
      config: {},
      options: {
        enableDedup: false,
        llmRunner,
      },
    });

    expect(llmRunner.run).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      content: "用户正在评估一项复杂迁移计划。",
      type: "episodic",
      source_message_ids: ["msg-2"],
    });
  });
});
