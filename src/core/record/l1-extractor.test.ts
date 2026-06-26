import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner } from "../types.js";

const tempDirs: string[] = [];

describe("extractL1Memories retry", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("retries once when the first extraction response is unparsable", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-retry-"));
    tempDirs.push(dataDir);
    const calls: Array<{ taskId?: string; systemPrompt?: string }> = [];
    const llmRunner: LLMRunner = {
      async run(params) {
        calls.push({ taskId: params.taskId, systemPrompt: params.systemPrompt });
        if (calls.length === 1) {
          return '[{"scene_name":"work","message_ids":["msg_1"],"memories":[{"content":"broken quote}]}]';
        }
        return JSON.stringify([
          {
            scene_name: "work",
            message_ids: ["msg_1", "msg_2"],
            memories: [
              {
                content: "User prefers concise engineering status updates.",
                type: "instruction",
                priority: 80,
                source_message_ids: ["msg_1"],
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
      baseDir: dataDir,
      config: {},
      options: { enableDedup: false, llmRunner },
    });

    expect(calls.map((c) => c.taskId)).toEqual(["l1-extraction", "l1-extraction-retry"]);
    expect(calls[1]?.systemPrompt).toContain("Previous output was not valid JSON");
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.records[0]?.content).toBe("User prefers concise engineering status updates.");
  });

  it("does not retry a valid empty extraction array", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-retry-"));
    tempDirs.push(dataDir);
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
      baseDir: dataDir,
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
      id: "msg_1",
      role: "user",
      content: "Please remember that I prefer concise engineering status updates during implementation work.",
      timestamp: Date.now(),
    },
    {
      id: "msg_2",
      role: "assistant",
      content: "Understood. I will keep engineering status updates concise during implementation work.",
      timestamp: Date.now() + 1,
    },
  ];
}
