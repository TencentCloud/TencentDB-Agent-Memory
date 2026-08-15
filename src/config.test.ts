/**
 * Config-parse tests for recall.cacheSafe group (issue #120).
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig — recall.cacheSafe", () => {
  it("defaults are backwards-compatible (legacy user-prefix, no dedup)", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.cacheSafe).toEqual({
      placement: "user-prefix",
      deterministicOrder: false,
      sessionDedup: false,
      sessionDedupMax: 32,
      diagnostics: false,
    });
  });

  it("parses cache-safe settings when provided", () => {
    const cfg = parseConfig({
      recall: {
        cacheSafe: {
          placement: "system-tail-dynamic",
          deterministicOrder: true,
          sessionDedup: true,
          sessionDedupMax: 8,
          diagnostics: true,
        },
      },
    });
    expect(cfg.recall.cacheSafe.placement).toBe("system-tail-dynamic");
    expect(cfg.recall.cacheSafe.deterministicOrder).toBe(true);
    expect(cfg.recall.cacheSafe.sessionDedup).toBe(true);
    expect(cfg.recall.cacheSafe.sessionDedupMax).toBe(8);
    expect(cfg.recall.cacheSafe.diagnostics).toBe(true);
  });

  it("rejects unknown placement, falls back to user-prefix default", () => {
    const cfg = parseConfig({ recall: { cacheSafe: { placement: "bogus" } } });
    expect(cfg.recall.cacheSafe.placement).toBe("user-prefix");
  });
});
