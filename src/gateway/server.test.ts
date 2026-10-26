import { describe, expect, it } from "vitest";
import type { RecallResult } from "../core/types.js";
import { buildRecallResponse } from "./server.js";

describe("buildRecallResponse", () => {
  it("keeps prepend-only recall context in the legacy context field", () => {
    const result: RecallResult = {
      prependContext: "L1 dynamic memory",
      recalledL1Memories: [
        { content: "L1 dynamic memory", score: 0.91, type: "episodic" },
      ],
      recallStrategy: "hybrid",
    };

    expect(buildRecallResponse(result)).toEqual({
      context: "L1 dynamic memory",
      prependContext: "L1 dynamic memory",
      strategy: "hybrid",
      memory_count: 1,
    });
  });

  it("returns split recall fields and joins legacy context as append then prepend", () => {
    const result: RecallResult = {
      appendSystemContext: "stable system context",
      prependContext: "dynamic L1 context",
      recalledL1Memories: [
        { content: "first", score: 0.87, type: "episodic" },
        { content: "second", score: 0.74, type: "instruction" },
      ],
      recallStrategy: "keyword",
    };

    expect(buildRecallResponse(result)).toEqual({
      context: "stable system context\n\ndynamic L1 context",
      appendSystemContext: "stable system context",
      prependContext: "dynamic L1 context",
      strategy: "keyword",
      memory_count: 2,
    });
  });
});
