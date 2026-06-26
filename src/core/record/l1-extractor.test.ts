import { describe, expect, it } from "vitest";

import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner, Logger } from "../types.js";

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("extractL1Memories", () => {
  it("treats provider content-filter refusals as failed extraction output", async () => {
    const refusingRunner: LLMRunner = {
      async run() {
        return "你好，我无法给到相关内容。\nProvider finish_reason: content_filter";
      },
    };

    const result = await extractL1Memories({
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: "Please remember that project Atlas has a deployment freeze until Friday.",
          timestamp: Date.now(),
        },
      ],
      sessionKey: "session-a",
      baseDir: "/tmp/tencentdb-agent-memory-test",
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
  });
});
