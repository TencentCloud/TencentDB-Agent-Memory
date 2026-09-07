import { describe, expect, it } from "vitest";

import { shapeRecallForOpenClawHook } from "./recall-injection.js";

describe("shapeRecallForOpenClawHook", () => {
  it("prepend mode keeps prependContext unchanged", () => {
    const result = shapeRecallForOpenClawHook(
      { appendSystemContext: "stable", prependContext: "dynamic" },
      "prepend",
    );

    expect(result).toEqual({ appendSystemContext: "stable", prependContext: "dynamic" });
    expect(result?.appendContext).toBeUndefined();
  });

  it("append mode moves prependContext to appendContext", () => {
    const result = shapeRecallForOpenClawHook(
      { appendSystemContext: "stable", prependContext: "dynamic", recallStrategy: "hybrid" },
      "append",
    );

    expect(result?.prependContext).toBeUndefined();
    expect(result?.appendContext).toBe("dynamic");
    expect(result?.appendSystemContext).toBe("stable");
    expect(result?.recallStrategy).toBe("hybrid");
  });

  it("append mode with no prependContext leaves result unchanged", () => {
    const result = shapeRecallForOpenClawHook({ appendSystemContext: "stable" }, "append");

    expect(result).toEqual({ appendSystemContext: "stable" });
    expect(result?.appendContext).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(shapeRecallForOpenClawHook(undefined, "append")).toBeUndefined();
  });
});
