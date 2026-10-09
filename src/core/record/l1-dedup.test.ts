import { describe, expect, it } from "vitest";

import { batchDedup } from "./l1-dedup.js";
import type { ExtractedMemory } from "./l1-writer.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";
import type { LLMRunner } from "../types.js";

describe("batchDedup", () => {
  it("caps merged priority at the strongest source memory priority", async () => {
    const newMemory: ExtractedMemory & { record_id: string } = {
      record_id: "new_1",
      content: "User asked the agent to only reply OK during diagnostic testing.",
      type: "instruction",
      priority: 75,
      source_message_ids: ["msg_1"],
      metadata: {},
      scene_name: "diagnostic testing",
    };

    const candidate: L1FtsResult = {
      record_id: "old_1",
      content: "User asked the assistant not to sound cold during a style adjustment.",
      type: "instruction",
      priority: 80,
      scene_name: "style adjustment",
      score: 1,
      timestamp_str: "2026-05-25T08:28:48.298Z",
      timestamp_start: "2026-05-25T08:28:48.298Z",
      timestamp_end: "2026-05-25T08:28:48.298Z",
      session_key: "session-a",
      session_id: "thread-a",
      metadata_json: "{}",
    };

    const vectorStore = {
      countL1: () => 1,
      isFtsAvailable: () => true,
      searchL1Fts: async () => [candidate],
    } as unknown as IMemoryStore;

    const llmRunner: LLMRunner = {
      async run() {
        return JSON.stringify([
          {
            record_id: "new_1",
            action: "merge",
            target_ids: ["old_1"],
            merged_content: "User wants extremely concise assistant replies and OK-style confirmations.",
            merged_type: "instruction",
            merged_priority: 95,
            merged_timestamps: ["2026-05-25T08:28:48.298Z"],
          },
        ]);
      },
    };

    const decisions = await batchDedup({
      memories: [newMemory],
      config: {},
      vectorStore,
      llmRunner,
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("merge");
    expect(decisions[0].merged_priority).toBe(80);
  });
});
