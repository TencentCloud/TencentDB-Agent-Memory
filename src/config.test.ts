import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig recall cache controls", () => {
  it("defaults to compatibility-safe recall injection behavior", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.injectionMode).toBe("prepend");
    expect(cfg.recall.showInjected).toBe(false);
  });

  it("accepts append injection and explicit injected-history visibility", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "append",
        showInjected: true,
      },
    });

    expect(cfg.recall.injectionMode).toBe("append");
    expect(cfg.recall.showInjected).toBe(true);
  });

  it("falls back to prepend for unknown injection modes", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "middle",
      },
    });

    expect(cfg.recall.injectionMode).toBe("prepend");
  });
});
