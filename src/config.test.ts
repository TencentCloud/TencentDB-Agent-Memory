import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig recall injection mode", () => {
  it("defaults to prepend for backward-compatible auto-recall injection", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.injectionMode).toBe("prepend");
  });

  it("accepts append mode for cache-friendlier dynamic recall injection", () => {
    const cfg = parseConfig({ recall: { injectionMode: "append" } });

    expect(cfg.recall.injectionMode).toBe("append");
  });

  it("falls back to prepend for unknown recall injection modes", () => {
    const cfg = parseConfig({ recall: { injectionMode: "sideways" } });

    expect(cfg.recall.injectionMode).toBe("prepend");
  });
});
