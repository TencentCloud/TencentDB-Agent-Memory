import { describe, expect, it } from "vitest";

import { shapeGatewayRecallResponse } from "./recall-response.js";

describe("shapeGatewayRecallResponse", () => {
  it("exposes stable and dynamic recall separately", () => {
    expect(
      shapeGatewayRecallResponse(
        {
          stableContext: "stable",
          dynamicContext: "dynamic",
          recallStrategy: "hybrid",
          recalledL1Memories: [
            { content: "memory", score: 0.8, type: "preference" },
          ],
        },
        "append",
      ),
    ).toEqual({
      context: "stable\n\ndynamic",
      stable_context: "stable",
      dynamic_context: "dynamic",
      injection_mode: "append",
      strategy: "hybrid",
      memory_count: 1,
    });
  });

  it("keeps dynamic recall in the legacy combined context", () => {
    expect(
      shapeGatewayRecallResponse(
        { dynamicContext: "dynamic" },
        "prepend",
      ),
    ).toMatchObject({
      context: "dynamic",
      stable_context: "",
      dynamic_context: "dynamic",
      injection_mode: "prepend",
    });
  });

  it("supports stable-only recall", () => {
    expect(
      shapeGatewayRecallResponse(
        { stableContext: "stable" },
        "prepend",
      ),
    ).toMatchObject({
      context: "stable",
      stable_context: "stable",
      dynamic_context: "",
    });
  });

  it("returns empty context fields when nothing was recalled", () => {
    expect(shapeGatewayRecallResponse({}, "prepend")).toMatchObject({
      context: "",
      stable_context: "",
      dynamic_context: "",
      memory_count: 0,
    });
  });
});
