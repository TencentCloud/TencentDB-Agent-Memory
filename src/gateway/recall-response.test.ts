import { describe, expect, it } from "vitest";
import { buildRecallResponse } from "./recall-response.js";

describe("buildRecallResponse", () => {
  it("preserves stable and dynamic recall context for gateway clients", () => {
    expect(
      buildRecallResponse({
        appendSystemContext: "<user-persona>stable</user-persona>",
        prependContext: "<relevant-memories>dynamic</relevant-memories>",
        recallStrategy: "hybrid",
        recalledL1Memories: [
          { content: "dynamic", score: 0.9, type: "episodic" },
        ],
      }),
    ).toEqual({
      context:
        "<user-persona>stable</user-persona>\n\n" +
        "<relevant-memories>dynamic</relevant-memories>",
      strategy: "hybrid",
      memory_count: 1,
    });
  });

  it("returns dynamic recall when no stable context exists", () => {
    expect(
      buildRecallResponse({
        prependContext: "<relevant-memories>dynamic</relevant-memories>",
        recalledL1Memories: [],
      }),
    ).toEqual({
      context: "<relevant-memories>dynamic</relevant-memories>",
      strategy: undefined,
      memory_count: 0,
    });
  });
});
