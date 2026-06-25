import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner } from "../types.js";
import { extractL1Memories } from "./l1-extractor.js";

const tempDirs: string[] = [];

describe("extractL1Memories diagnostics", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("persists the raw LLM response when extraction returns content-filter prose instead of JSON", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-diagnostics-"));
    tempDirs.push(baseDir);

    const messages: ConversationMessage[] = [
      {
        id: "msg-1",
        role: "user",
        content: "请持续追踪这个敏感新闻话题。",
        timestamp: Date.parse("2026-06-25T09:00:00+08:00"),
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "你好，我无法给到相关内容。",
        timestamp: Date.parse("2026-06-25T09:00:01+08:00"),
      },
    ];

    const llmRunner: LLMRunner = {
      async run() {
        return "你好，我无法给到相关内容。\nProvider finish_reason: content_filter";
      },
    };

    const result = await extractL1Memories({
      messages,
      sessionKey: "hermes:user-a",
      sessionId: "session-1",
      baseDir,
      config: {},
      options: { llmRunner, model: "tokenhub/glm" },
    });

    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(0);

    const diagnosticPath = path.join(baseDir, ".metadata", "l1-extraction-failures.jsonl");
    const diagnosticLines = (await fs.readFile(diagnosticPath, "utf-8")).trim().split("\n");
    expect(diagnosticLines).toHaveLength(1);

    const entry = JSON.parse(diagnosticLines[0]!) as Record<string, unknown>;
    expect(entry.reason).toBe("no_json_array");
    expect(entry.sessionKey).toBe("hermes:user-a");
    expect(entry.sessionId).toBe("session-1");
    expect(entry.model).toBe("tokenhub/glm");
    expect(entry.newMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(entry.rawResponse).toContain("content_filter");
    expect(entry.rawResponseLength).toBe("你好，我无法给到相关内容。\nProvider finish_reason: content_filter".length);
    expect(entry.rawResponseTruncated).toBe(false);
  });
});
