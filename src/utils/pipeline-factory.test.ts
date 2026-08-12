/**
 * P5 — single-writer gate tests (wave tdai-memory-subagents-2026-08-02, §5.8).
 *
 * Load-bearing asserts (критерий 18a): with memory.consolidation.enabled=true
 * createL2Runner/createL3Runner return no-op runners; with enabled=false the
 * current behaviour is preserved; the gate logs warnOnce at activation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createL2Runner, createL3Runner } from "./pipeline-factory.js";
import { parseConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { Logger } from "../core/types.js";

function collectingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warns.push(m),
      error: () => undefined,
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-p5-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("single-writer gate (memory.consolidation.enabled)", () => {
  it("enabled=true: createL2Runner returns a no-op (skipped, nothing extracted)", async () => {
    const cfg = parseConfig({ consolidation: { enabled: true } });
    const { logger, warns } = collectingLogger();

    const runner = createL2Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: { llm: {} }, // would normally drive extraction
      vectorStore: undefined,
      logger,
    });

    // No scene_blocks may be written by the no-op runner.
    const result = await runner("session-1", "cursor-1");
    expect(result).toEqual({ skipped: true, latestCursor: "cursor-1" });
    expect(fs.existsSync(path.join(dir, "scene_blocks"))).toBe(false);

    // warnOnce fired at activation.
    expect(warns.some((w) => w.includes("single-writer-gate") && w.includes("L2"))).toBe(true);
  });

  it("enabled=true: createL3Runner returns a no-op (nothing generated)", async () => {
    const cfg = parseConfig({ consolidation: { enabled: true } });
    const { logger, warns } = collectingLogger();

    const runner = createL3Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: { llm: {} },
      vectorStore: undefined,
      logger,
    });

    const result = await runner();
    expect(result).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "persona.md"))).toBe(false);
    expect(warns.some((w) => w.includes("single-writer-gate") && w.includes("L3"))).toBe(true);
  });

  it("enabled=false: current behaviour preserved (L2 runs its real path, no gate warn)", async () => {
    const cfg = parseConfig({}) as MemoryTdaiConfig;
    expect(cfg.consolidation.enabled).toBe(false); // default
    const { logger, warns } = collectingLogger();

    const runner = createL2Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: null, // no host config and no LLM runner → real path warns + returns
      vectorStore: undefined,
      logger,
    });

    const result = await runner("session-1");
    expect(result).toBeUndefined();
    // the REAL L2 path warns about missing config — the gate warn must NOT appear
    expect(warns.some((w) => w.includes("single-writer-gate"))).toBe(false);
    expect(warns.some((w) => w.includes("No OpenClaw config"))).toBe(true);
  });

  it("enabled=false: L3 keeps its real trigger path", async () => {
    const cfg = parseConfig({});
    const { logger, warns } = collectingLogger();

    const runner = createL3Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: null,
      vectorStore: undefined,
      logger,
    });

    // Fresh dir → no persona state → trigger says "not needed", no generation.
    const result = await runner();
    expect(result).toBeUndefined();
    expect(warns.some((w) => w.includes("single-writer-gate"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "persona.md"))).toBe(false);
  });
});
