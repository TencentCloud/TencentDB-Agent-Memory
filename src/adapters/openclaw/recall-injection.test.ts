import { describe, expect, it } from "vitest";

import { shapeOpenClawRecallResult } from "./recall-injection.js";

describe("shapeOpenClawRecallResult", () => {
  it("keeps dynamic recall in prependContext", () => {
    expect(
      shapeOpenClawRecallResult(
        {
          appendSystemContext: "stable",
          dynamicContext: "dynamic",
        },
        "prepend",
      ),
    ).toEqual({
      appendSystemContext: "stable",
      prependContext: "dynamic",
    });
  });

  it("moves dynamic recall to appendContext", () => {
    expect(
      shapeOpenClawRecallResult(
        {
          appendSystemContext: "stable",
          dynamicContext: "dynamic",
        },
        "append",
      ),
    ).toEqual({
      appendSystemContext: "stable",
      appendContext: "dynamic",
    });
  });

  it("does not retain prependContext in append mode", () => {
    const result = shapeOpenClawRecallResult(
      { dynamicContext: "dynamic" },
      "append",
    );

    expect(result).not.toHaveProperty("prependContext");
    expect(result).toEqual({ appendContext: "dynamic" });
  });

  it("does not create appendContext when dynamic recall is absent", () => {
    expect(
      shapeOpenClawRecallResult(
        {
          appendSystemContext: "stable",
          dynamicContext: "",
        },
        "append",
      ),
    ).toEqual({ appendSystemContext: "stable" });
  });

  it("returns undefined for undefined input", () => {
    expect(shapeOpenClawRecallResult(undefined, "append")).toBeUndefined();
  });

  it("preserves recall metadata", () => {
    const recalledL1Memories = [
      { content: "remembered", score: 0.9, type: "preference" },
    ];

    expect(
      shapeOpenClawRecallResult(
        {
          dynamicContext: "dynamic",
          recalledL1Memories,
          recalledL3Persona: "persona",
          recallStrategy: "hybrid",
        },
        "append",
      ),
    ).toEqual({
      appendContext: "dynamic",
      recalledL1Memories,
      recalledL3Persona: "persona",
      recallStrategy: "hybrid",
    });
  });
});
