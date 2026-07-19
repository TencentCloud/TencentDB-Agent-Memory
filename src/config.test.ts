/**
 * config.test.ts — Unit tests for config parsing with new recall fields.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig — recall.injectionMode", () => {
  it("defaults to 'prepend' when not specified", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.injectionMode).toBe("prepend");
  });

  it("accepts 'prepend' explicitly", () => {
    const cfg = parseConfig({ recall: { injectionMode: "prepend" } });
    expect(cfg.recall.injectionMode).toBe("prepend");
  });

  it("accepts 'append'", () => {
    const cfg = parseConfig({ recall: { injectionMode: "append" } });
    expect(cfg.recall.injectionMode).toBe("append");
  });

  it("rejects invalid value, falls back to 'prepend'", () => {
    const cfg = parseConfig({ recall: { injectionMode: "invalid" } as Record<string, unknown> });
    expect(cfg.recall.injectionMode).toBe("prepend");
  });

  it("rejects empty string, falls back to 'prepend'", () => {
    const cfg = parseConfig({ recall: { injectionMode: "" } });
    expect(cfg.recall.injectionMode).toBe("prepend");
  });
});

describe("parseConfig — recall.showInjected", () => {
  it("defaults to false", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.showInjected).toBe(false);
  });

  it("accepts true", () => {
    const cfg = parseConfig({ recall: { showInjected: true } });
    expect(cfg.recall.showInjected).toBe(true);
  });

  it("accepts false explicitly", () => {
    const cfg = parseConfig({ recall: { showInjected: false } });
    expect(cfg.recall.showInjected).toBe(false);
  });

  it("treats non-boolean as false (via bool helper)", () => {
    const cfg = parseConfig({ recall: { showInjected: "yes" } as Record<string, unknown> });
    expect(cfg.recall.showInjected).toBe(false);
  });
});

describe("parseConfig — recall.cacheDiagnostics", () => {
  it("defaults to false", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.cacheDiagnostics).toBe(false);
  });

  it("accepts true", () => {
    const cfg = parseConfig({ recall: { cacheDiagnostics: true } });
    expect(cfg.recall.cacheDiagnostics).toBe(true);
  });
});

describe("parseConfig — backward compatibility", () => {
  it("full config without new fields behaves identically to before", () => {
    const cfg = parseConfig({
      recall: {
        enabled: true,
        maxResults: 10,
        maxCharsPerMemory: 500,
        maxTotalRecallChars: 3000,
        scoreThreshold: 0.5,
        strategy: "keyword",
        timeoutMs: 10000,
      },
    });
    // Existing fields unchanged
    expect(cfg.recall.enabled).toBe(true);
    expect(cfg.recall.maxResults).toBe(10);
    expect(cfg.recall.maxCharsPerMemory).toBe(500);
    expect(cfg.recall.maxTotalRecallChars).toBe(3000);
    expect(cfg.recall.scoreThreshold).toBe(0.5);
    expect(cfg.recall.strategy).toBe("keyword");
    expect(cfg.recall.timeoutMs).toBe(10000);
    // New fields use defaults
    expect(cfg.recall.injectionMode).toBe("prepend");
    expect(cfg.recall.showInjected).toBe(false);
    expect(cfg.recall.cacheDiagnostics).toBe(false);
  });

  it("empty config produces all defaults", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.injectionMode).toBe("prepend");
    expect(cfg.recall.showInjected).toBe(false);
    expect(cfg.recall.cacheDiagnostics).toBe(false);
  });
});
