import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractL1Memories } from "./l1-extractor.js";
import { readMemoryRecords } from "./l1-reader.js";
import type { LLMRunner, Logger } from "../types.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("extractL1Memories", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("drops LLM memories that are not grounded in source messages", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-l1-validation-"));
    tempDirs.push(baseDir);

    const llmRunner: LLMRunner = {
      async run() {
        return JSON.stringify([
          {
            scene_name: "typescript examples",
            message_ids: ["msg_1"],
            memories: [
              {
                content: "User prefers concise TypeScript examples.",
                type: "instruction",
                priority: 80,
                source_message_ids: ["msg_1"],
                metadata: {},
              },
              {
                content: "User is a professional violinist living in Berlin.",
                type: "persona",
                priority: 90,
                source_message_ids: ["msg_1"],
                metadata: {},
              },
            ],
          },
        ]);
      },
    };

    const result = await extractL1Memories({
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: "Please remember that I prefer concise TypeScript examples.",
          timestamp: Date.now(),
        },
      ],
      sessionKey: "session-a",
      sessionId: "thread-a",
      baseDir,
      config: {},
      options: {
        enableDedup: false,
        llmRunner,
      },
      logger: noopLogger,
    });

    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(result.records[0].content).toBe("User prefers concise TypeScript examples.");

    const records = await readMemoryRecords("session-a", baseDir);
    expect(records.map((record) => record.content)).toEqual([
      "User prefers concise TypeScript examples.",
    ]);
  });
});
