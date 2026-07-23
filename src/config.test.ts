import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig recall injection options", () => {
  it("uses backward-compatible cache-safe defaults", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.injectionMode).toBe("prepend");
    expect(cfg.recall.showInjected).toBe(false);
  });

  it("accepts append placement and injected-history visibility", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "append",
        showInjected: true,
      },
    });

    expect(cfg.recall.injectionMode).toBe("append");
    expect(cfg.recall.showInjected).toBe(true);
  });

  it("falls back to prepend for an unknown injection mode", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "unsupported",
      },
    });

    expect(cfg.recall.injectionMode).toBe("prepend");
  });
});

