import { describe, expect, it } from "vitest";
import { buildGatewayRecallResponse } from "./recall-response.js";

describe("buildGatewayRecallResponse", () => {
  it("preserves dynamic and stable context as separate fields", () => {
    expect(buildGatewayRecallResponse({
      prependContext: "dynamic L1",
      appendSystemContext: "stable persona",
      recallStrategy: "hybrid",
      recalledL1Memories: [{ content: "x", score: 1, type: "fact" }],
    })).toEqual({
      context: "stable persona",
      prepend_context: "dynamic L1",
      append_system_context: "stable persona",
      strategy: "hybrid",
      memory_count: 1,
    });
  });

  it("keeps the legacy context field backward compatible", () => {
    expect(buildGatewayRecallResponse({ prependContext: "dynamic only" })).toEqual({
      context: "",
      prepend_context: "dynamic only",
      strategy: undefined,
      memory_count: 0,
    });
  });
});
