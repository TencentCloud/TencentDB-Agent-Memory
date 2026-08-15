import { describe, expect, it } from "vitest";

import { describeRecallShape } from "./recall-shape-diagnostics.js";

describe("describeRecallShape", () => {
  it("reports stable hash + prepend placement when prependContext present", () => {
    const snap = describeRecallShape({ appendSystemContext: "persona", prependContext: "mem" });

    expect(snap.stableChars).toBe(7);
    expect(snap.stableHash).toMatch(/^[0-9a-f]{8}$/);
    expect(snap.dynamicPlacement).toBe("prepend");
    expect(snap.dynamicChars).toBe(3);
  });

  it("reports append placement when appendContext present", () => {
    const snap = describeRecallShape({ appendContext: "mem" });

    expect(snap.dynamicPlacement).toBe("append");
    expect(snap.dynamicChars).toBe(3);
    expect(snap.stableHash).toBe("-");
  });

  it("reports none when no dynamic recall", () => {
    const snap = describeRecallShape({ appendSystemContext: "persona" });

    expect(snap.dynamicPlacement).toBe("none");
    expect(snap.dynamicChars).toBe(0);
  });

  it("stable hash is stable for identical content, differs when changed", () => {
    const a = describeRecallShape({ appendSystemContext: "persona" }).stableHash;
    const b = describeRecallShape({ appendSystemContext: "persona" }).stableHash;
    const c = describeRecallShape({ appendSystemContext: "persona2" }).stableHash;

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
