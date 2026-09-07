import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig recall injection mode", () => {
  it("defaults to prepend", () => {
    expect(parseConfig({}).recall.injectionMode).toBe("prepend");
  });

  it("accepts append", () => {
    expect(
      parseConfig({
        recall: { injectionMode: "append" },
      }).recall.injectionMode,
    ).toBe("append");
  });

  it("falls back to prepend for an unknown mode", () => {
    expect(
      parseConfig({
        recall: { injectionMode: "nonsense" },
      }).recall.injectionMode,
    ).toBe("prepend");
  });
});
