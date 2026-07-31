import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../../config.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import type { MemoryPipelineManager } from "../../utils/pipeline-manager.js";
import type { Logger } from "../types.js";
import { performAutoCapture } from "./auto-capture.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("performAutoCapture", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("does not notify the pipeline when the checkpoint filters an empty duplicate batch", async () => {
    const pluginDataDir = await mkdtemp(path.join(tmpdir(), "tdai-empty-capture-"));
    tempDirs.push(pluginDataDir);

    const notifyConversation = vi.fn(async () => undefined);
    const scheduler = { notifyConversation } as unknown as MemoryPipelineManager;
    const params = {
      messages: [
        {
          role: "user",
          content: "Remember that Project Atlas is frozen until Friday.",
          timestamp: 1_785_427_200_000,
        },
        {
          role: "assistant",
          content: "Recorded.",
          timestamp: 1_785_427_200_100,
        },
      ],
      sessionKey: "agent:main:atlas",
      sessionId: "thread-atlas",
      cfg: parseConfig({}),
      pluginDataDir,
      logger,
      scheduler,
      pluginStartTimestamp: 0,
    };

    const first = await performAutoCapture(params);
    const duplicate = await performAutoCapture(params);

    expect(first).toMatchObject({
      schedulerNotified: true,
      l0RecordedCount: 2,
    });
    expect(duplicate).toMatchObject({
      schedulerNotified: false,
      l0RecordedCount: 0,
    });
    expect(notifyConversation).toHaveBeenCalledTimes(1);
    expect(notifyConversation).toHaveBeenCalledWith("agent:main:atlas", []);

    const checkpoint = await new CheckpointManager(pluginDataDir, logger).read();
    expect(checkpoint.l0_conversations_count).toBe(1);
    expect(checkpoint.total_processed).toBe(2);
  });
});
