import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig recall prompt-cache controls", () => {
  it("uses backward-compatible injection and safe history defaults", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.injectionMode).toBe("prepend");
    expect(cfg.recall.showInjected).toBe(false);
  });

  it("accepts explicit append placement and history visibility", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "append",
        showInjected: true,
      },
    });

    expect(cfg.recall.injectionMode).toBe("append");
    expect(cfg.recall.showInjected).toBe(true);
  });

  it("falls back when an unknown injection mode is configured", () => {
    const cfg = parseConfig({ recall: { injectionMode: "cache-magic" } });

    expect(cfg.recall.injectionMode).toBe("prepend");
  });
});
