import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import type { LLMRunner } from "../types.js";

const tempDirs: string[] = [];

describe("extractL1Memories diagnostics", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("persists malformed LLM extraction responses for troubleshooting", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-diagnostics-"));
    tempDirs.push(dataDir);

    const messages: ConversationMessage[] = [
      {
        id: "msg_1",
        role: "user",
        content: "Remember that I prefer short status updates for engineering work.",
        timestamp: Date.now(),
      },
      {
        id: "msg_2",
        role: "assistant",
        content: "Got it. I will keep status updates concise.",
        timestamp: Date.now() + 1,
      },
    ];
    const llmRunner: LLMRunner = {
      async run() {
        return '[{"scene_name":"work","message_ids":["msg_1"],"memories":[{"content":"broken quote}]}]';
      },
    };

    const result = await extractL1Memories({
      messages,
      sessionKey: "diagnostic-session",
      sessionId: "session-1",
      baseDir: dataDir,
      config: {},
      options: { llmRunner },
    });

    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(0);

    const diagnosticPath = path.join(dataDir, ".metadata", "l1-extraction-failures.jsonl");
    const lines = (await fs.readFile(diagnosticPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.reason).toBe("parse_error");
    expect(entry.sessionKey).toBe("diagnostic-session");
    expect(entry.newMessageIds).toEqual(["msg_1", "msg_2"]);
    expect(entry.rawResponse).toContain("broken quote");
  });
});
