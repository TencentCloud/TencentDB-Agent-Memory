import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner } from "../types.js";
import { extractL1Memories } from "./l1-extractor.js";

const tempDirs: string[] = [];

describe("extractL1Memories retry", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("retries once when the first extraction response is unparsable", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-retry-"));
    tempDirs.push(baseDir);

    const calls: Array<{ taskId: string; systemPrompt?: string }> = [];
    const llmRunner: LLMRunner = {
      async run(params) {
        calls.push({ taskId: params.taskId, systemPrompt: params.systemPrompt });
        if (calls.length === 1) {
          return '[{"scene_name":"工程状态同步","message_ids":["msg-1"],"memories":[{"content":"broken quote}]}]';
        }

        return JSON.stringify([
          {
            scene_name: "工程状态同步",
            message_ids: ["msg-1", "msg-2"],
            memories: [
              {
                content: "用户偏好工程实现过程中的状态更新保持简洁。",
                type: "instruction",
                priority: 80,
                source_message_ids: ["msg-1"],
                metadata: {},
              },
            ],
          },
        ]);
      },
    };

    const result = await extractL1Memories({
      messages: sampleMessages(),
      sessionKey: "retry-session",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner },
    });

    expect(calls.map((c) => c.taskId)).toEqual(["l1-extraction", "l1-extraction-retry"]);
    expect(calls[1]?.systemPrompt).toContain("Previous output was not valid JSON");
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.records[0]?.content).toBe("用户偏好工程实现过程中的状态更新保持简洁。");
  });

  it("does not retry a valid empty extraction array", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-retry-"));
    tempDirs.push(baseDir);

    let calls = 0;
    const llmRunner: LLMRunner = {
      async run() {
        calls++;
        return "[]";
      },
    };

    const result = await extractL1Memories({
      messages: sampleMessages(),
      sessionKey: "empty-session",
      baseDir,
      config: {},
      options: { enableDedup: false, llmRunner },
    });

    expect(calls).toBe(1);
    expect(result.extractedCount).toBe(0);
    expect(result.storedCount).toBe(0);
  });
});

function sampleMessages(): ConversationMessage[] {
  return [
    {
      id: "msg-1",
      role: "user",
      content: "以后工程实现过程中请给我简洁的状态更新。",
      timestamp: Date.parse("2026-06-25T10:00:00+08:00"),
    },
    {
      id: "msg-2",
      role: "assistant",
      content: "明白，后续工程状态更新会保持简洁。",
      timestamp: Date.parse("2026-06-25T10:00:01+08:00"),
    },
  ];
}
