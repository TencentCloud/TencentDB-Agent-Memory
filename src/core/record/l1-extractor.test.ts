import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

describe("extractL1Memories", () => {
  it("does not override the timeout of a host-neutral LLM runner", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "tdai-l1-timeout-"));
    const run = vi.fn(async () => JSON.stringify([
      {
        scene_name: "preferences",
        message_ids: ["m1"],
        memories: [
          {
            content: "User prefers concise TypeScript explanations.",
            type: "preference",
            priority: 80,
            source_message_ids: ["m1"],
            metadata: {},
          },
        ],
      },
    ]));
    const llmRunner = { run } satisfies LLMRunner;

    await extractL1Memories({
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Please remember that I prefer concise TypeScript explanations.",
          timestamp: Date.now(),
        },
      ],
      sessionKey: "session-1",
      baseDir,
      config: {},
      options: {
        enableDedup: false,
        llmRunner,
      },
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).not.toHaveProperty("timeoutMs");
  });
});
