import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("recall config — prompt-cache knobs (issue #120)", () => {
  it("applies safe defaults with zero config", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.injectionMode).toBe("ephemeral");
    expect(cfg.recall.stableContextPolicy).toBe("session-frozen");
    expect(cfg.recall.stripInjectedFromHistory).toBe(true);
    expect(cfg.recall.systemInjection).toBe("auto");
  });

  it("applies safe defaults when recall group is present but keys are absent", () => {
    const cfg = parseConfig({ recall: { enabled: true, maxResults: 3 } });
    expect(cfg.recall.injectionMode).toBe("ephemeral");
    expect(cfg.recall.stableContextPolicy).toBe("session-frozen");
    expect(cfg.recall.stripInjectedFromHistory).toBe(true);
    expect(cfg.recall.systemInjection).toBe("auto");
  });

  it("accepts every whitelisted value", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "session-stable",
        stableContextPolicy: "latest",
        stripInjectedFromHistory: false,
        systemInjection: "hook-context",
      },
    });
    expect(cfg.recall.injectionMode).toBe("session-stable");
    expect(cfg.recall.stableContextPolicy).toBe("latest");
    expect(cfg.recall.stripInjectedFromHistory).toBe(false);
    expect(cfg.recall.systemInjection).toBe("hook-context");
  });

  it("falls back to defaults for values outside the whitelist", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "per-turn",
        stableContextPolicy: "always-fresh",
        stripInjectedFromHistory: "yes", // wrong type → default
        systemInjection: "cache-boundary",
      },
    });
    expect(cfg.recall.injectionMode).toBe("ephemeral");
    expect(cfg.recall.stableContextPolicy).toBe("session-frozen");
    expect(cfg.recall.stripInjectedFromHistory).toBe(true);
    expect(cfg.recall.systemInjection).toBe("auto");
  });

  it("falls back to defaults for empty / whitespace strings", () => {
    const cfg = parseConfig({
      recall: {
        injectionMode: "",
        stableContextPolicy: "   ",
        systemInjection: "",
      },
    });
    expect(cfg.recall.injectionMode).toBe("ephemeral");
    expect(cfg.recall.stableContextPolicy).toBe("session-frozen");
    expect(cfg.recall.systemInjection).toBe("auto");
  });

  it("does not disturb pre-existing recall keys", () => {
    const cfg = parseConfig({
      recall: { strategy: "keyword", timeoutMs: 1234, injectionMode: "session-stable" },
    });
    expect(cfg.recall.strategy).toBe("keyword");
    expect(cfg.recall.timeoutMs).toBe(1234);
    expect(cfg.recall.injectionMode).toBe("session-stable");
  });
});
