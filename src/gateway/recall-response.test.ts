import { describe, expect, it } from "vitest";
import { toGatewayRecallResponse } from "./recall-response.js";

describe("toGatewayRecallResponse", () => {
  it("preserves dynamic and stable context without changing the legacy field", () => {
    expect(toGatewayRecallResponse({
      prependContext: "dynamic L1 evidence",
      appendSystemContext: "stable L2/L3 guidance",
      recallStrategy: "hybrid",
      recalledL1Memories: [
        { content: "memory", score: 0.9, type: "fact" },
      ],
    })).toEqual({
      context: "stable L2/L3 guidance",
      prepend_context: "dynamic L1 evidence",
      append_system_context: "stable L2/L3 guidance",
      strategy: "hybrid",
      memory_count: 1,
    });
  });

  it("keeps a backward-compatible empty context when recall finds nothing", () => {
    expect(toGatewayRecallResponse({})).toEqual({
      context: "",
      strategy: undefined,
      memory_count: 0,
    });
  });
});
