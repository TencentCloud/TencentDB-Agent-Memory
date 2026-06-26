import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { recordConversation } from "../core/conversation/l0-recorder.js";
import type { LLMRunner, Logger } from "../core/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { createL1Runner } from "./pipeline-factory.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("createL1Runner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("does not advance the L1 cursor when extraction fails", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-l1-runner-"));
    tempDirs.push(baseDir);

    await recordConversation({
      sessionKey: "session-a",
      sessionId: "thread-a",
      baseDir,
      rawMessages: [
        {
          id: "msg_1",
          role: "user",
          content: "Please remember that project Atlas has a deployment freeze until Friday.",
          timestamp: Date.now(),
        },
      ],
      logger: noopLogger,
    });

    const failingRunner: LLMRunner = {
      async run() {
        throw new Error("Provider finish_reason: content_filter");
      },
    };

    const runner = createL1Runner({
      pluginDataDir: baseDir,
      cfg: parseConfig({ extraction: { enableDedup: false } }),
      openclawConfig: {},
      vectorStore: undefined,
      embeddingService: undefined,
      logger: noopLogger,
      llmRunner: failingRunner,
    });

    await expect(runner({ sessionKey: "session-a" })).rejects.toThrow(/L1 extraction failed/i);

    const checkpoint = new CheckpointManager(baseDir, noopLogger);
    const state = await checkpoint.read();

    expect(state.runner_states["session-a"]?.last_l1_cursor ?? 0).toBe(0);
    expect(state.total_memories_extracted).toBe(0);
  });
});
