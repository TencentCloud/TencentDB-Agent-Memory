import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner, LLMRunParams, Logger } from "../types.js";

class SequenceRunner implements LLMRunner {
  public calls: LLMRunParams[] = [];

  constructor(private readonly outputs: string[]) {}

  async run(params: LLMRunParams): Promise<string> {
    this.calls.push(params);
    return this.outputs.shift() ?? "";
  }
}

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-test-"));
  tempDirs.push(dir);
  return dir;
}

function sampleMessages(): ConversationMessage[] {
  const base = Date.now();
  return [
    {
      id: "msg_u1",
      role: "user",
      content: "以后回答默认用中文，简洁一点，记住这个长期要求。",
      timestamp: base,
    },
    {
      id: "msg_a1",
      role: "assistant",
      content: "好的，我以后默认用中文并保持简洁。",
      timestamp: base + 1,
    },
  ];
}

describe("extractL1Memories retry recovery", () => {
  it("retries once when the first extraction returns natural language instead of JSON", async () => {
    const runner = new SequenceRunner([
      "好的，我先分析这段对话，然后再提取记忆。",
      JSON.stringify([
        {
          scene_name: "我在和用户确认长期回答风格偏好",
          message_ids: ["msg_u1", "msg_a1"],
          memories: [
            {
              content: "用户要求 AI 以后默认用中文并保持简洁。",
              type: "instruction",
              priority: 95,
              source_message_ids: ["msg_u1"],
              metadata: {},
            },
          ],
        },
      ]),
    ]);

    const result = await extractL1Memories({
      messages: sampleMessages(),
      sessionKey: "test_session",
      baseDir: await makeTempDir(),
      config: {},
      logger,
      options: {
        llmRunner: runner,
        enableDedup: false,
      },
    });

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.taskId).toBe("l1-extraction");
    expect(runner.calls[1]?.taskId).toBe("l1-extraction-retry");
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.sceneNames).toEqual(["我在和用户确认长期回答风格偏好"]);
    expect(result.records[0]?.content).toContain("默认用中文");
  });

  it("retries once when the first extraction returns an empty string", async () => {
    const runner = new SequenceRunner([
      "",
      JSON.stringify([
        {
          scene_name: "我在和用户确认长期回答风格偏好",
          message_ids: ["msg_u1", "msg_a1"],
          memories: [],
        },
      ]),
    ]);

    const result = await extractL1Memories({
      messages: sampleMessages(),
      sessionKey: "test_session_empty",
      baseDir: await makeTempDir(),
      config: {},
      logger,
      options: {
        llmRunner: runner,
        enableDedup: false,
      },
    });

    expect(runner.calls).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.sceneNames).toEqual(["我在和用户确认长期回答风格偏好"]);
    expect(result.extractedCount).toBe(0);
    expect(result.storedCount).toBe(0);
  });
});
