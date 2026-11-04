import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { applyLlmLayerOverride } from "./adapters/standalone/llm-provider-resolver.js";

/**
 * Per-layer LLM overrides — `llm.layers.{l1,l2,l3}` (issue #1396).
 *
 * Why the feature exists: the pipeline stages have opposite requirements. L1
 * extraction must return strict JSON inside a small budget (a reasoning model can
 * spend the whole budget on reasoning, the response gets truncated mid-JSON and
 * the batch produces nothing), while L2 scene synthesis / L3 persona are
 * judgement tasks that benefit from a larger budget. With only global `llm.*`
 * settings, tuning one stage degrades another.
 *
 * Two properties matter and are both covered here:
 *   1. parsing + fail-fast (a typo such as `l4` must not be silently ignored),
 *   2. merge semantics (only the fields present in the override change; an
 *      absent section or layer leaves the behaviour exactly as before).
 */

describe("llm.layers parsing", () => {
  it("parses per-layer model / maxTokens / timeoutMs", () => {
    const cfg = parseConfig({
      llm: {
        enabled: true,
        layers: {
          l1: { model: "strict-json-model", maxTokens: 4096 },
          l2: { maxTokens: 16384, timeoutMs: 300_000 },
        },
      },
    });

    expect(cfg.llm.layers).toEqual({
      l1: { model: "strict-json-model", maxTokens: 4096 },
      l2: { maxTokens: 16384, timeoutMs: 300_000 },
    });
  });

  it("leaves layers undefined when the section is absent (backwards compatible)", () => {
    const cfg = parseConfig({ llm: { enabled: true } });
    expect(cfg.llm.layers).toBeUndefined();
  });

  it("fails fast on an unknown layer name instead of silently ignoring the override", () => {
    expect(() => parseConfig({ llm: { layers: { l4: { maxTokens: 8192 } } } })).toThrow(
      /not a valid layer name/,
    );
    expect(() => parseConfig({ llm: { layers: { L1: { maxTokens: 8192 } } } })).toThrow(
      /not a valid layer name/,
    );
  });

  it("rejects a non-object llm.layers", () => {
    expect(() => parseConfig({ llm: { layers: ["l1"] } })).toThrow(/must be an object/);
  });
});

describe("applyLlmLayerOverride", () => {
  const base = {
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    model: "global-model",
    maxTokens: 4096,
    timeoutMs: 120_000,
  };

  it("applies only the fields present in the layer override", () => {
    expect(applyLlmLayerOverride(base, "l1", { l1: { model: "m-l1" } })).toEqual({
      ...base,
      model: "m-l1",
    });
    expect(applyLlmLayerOverride(base, "l2", { l2: { maxTokens: 16384 } })).toEqual({
      ...base,
      maxTokens: 16384,
    });
  });

  it("returns the base config unchanged when the layer or the whole section is absent", () => {
    expect(applyLlmLayerOverride(base, "l1", undefined)).toBe(base);
    expect(applyLlmLayerOverride(base, "l3", { l1: { model: "m-l1" } })).toBe(base);
    expect(applyLlmLayerOverride(base, undefined, { l1: { model: "m-l1" } })).toBe(base);
  });

  it("does not mutate the base config", () => {
    applyLlmLayerOverride(base, "l1", { l1: { model: "m-l1", maxTokens: 1, timeoutMs: 2 } });
    expect(base.model).toBe("global-model");
    expect(base.maxTokens).toBe(4096);
    expect(base.timeoutMs).toBe(120_000);
  });
});
