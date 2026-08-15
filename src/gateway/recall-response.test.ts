import { describe, expect, it } from "vitest";
import { buildRecallResponse } from "./recall-response.js";
import type { RecallResult } from "../core/types.js";

describe("buildRecallResponse", () => {
  it("keeps legacy context while exposing structured stable and dynamic parts", () => {
    const result: RecallResult = {
      appendSystemContext: "<user-persona>stable</user-persona>",
      prependContext: "<relevant-memories>dynamic</relevant-memories>",
      contextParts: {
        stable: {
          content: "<user-persona>stable</user-persona>",
          placement: "system",
          cachePolicy: "cacheable",
          persist: false,
        },
        dynamic: {
          content: "<relevant-memories>dynamic</relevant-memories>",
          placement: "user",
          cachePolicy: "ephemeral",
          persist: false,
        },
      },
      recalledL1Memories: [{ content: "dynamic", score: 0.9, type: "episodic" }],
      recallStrategy: "hybrid",
      cacheDebug: { dynamicPersistPolicy: "never" },
    };

    expect(buildRecallResponse(result)).toEqual({
      context: "<user-persona>stable</user-persona>",
      stable_context: "<user-persona>stable</user-persona>",
      dynamic_context: "<relevant-memories>dynamic</relevant-memories>",
      context_parts: {
        stable: {
          content: "<user-persona>stable</user-persona>",
          placement: "system",
          cache_policy: "cacheable",
          persist: false,
        },
        dynamic: {
          content: "<relevant-memories>dynamic</relevant-memories>",
          placement: "user",
          cache_policy: "ephemeral",
          persist: false,
        },
      },
      strategy: "hybrid",
      memory_count: 1,
      cache_debug: { dynamicPersistPolicy: "never" },
    });
  });
});


