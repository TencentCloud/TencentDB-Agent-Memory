import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMRunner, Logger } from "../types.js";
import { extractL1Memories } from "./l1-extractor.js";

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

  it("treats provider content-filter prose as a failed extraction", async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "tdai-l1-content-filter-"));
    tempDirs.push(baseDir);

    const refusingRunner: LLMRunner = {
      async run() {
        return "你好，我无法给到相关内容。\nProvider finish_reason: content_filter";
      },
    };

    const result = await extractL1Memories({
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Please remember that project Atlas has a deployment freeze until Friday.",
          timestamp: Date.parse("2026-06-03T06:21:08Z"),
        },
      ],
      sessionKey: "session-a",
      baseDir,
      config: {},
      options: {
        enableDedup: false,
        llmRunner: refusingRunner,
      },
      logger: noopLogger,
    });

    expect(result.success).toBe(false);
    expect(result.extractedCount).toBe(0);
    expect(result.storedCount).toBe(0);
    expect(result.failureReason).toBe("content_filter");
  });
});
