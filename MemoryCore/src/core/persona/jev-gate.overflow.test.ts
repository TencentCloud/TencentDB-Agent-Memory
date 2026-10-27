/**
 * Integration tests for the JEV gate overflow paths.
 *
 * An oversized state must either defer (default policy - the unchanged
 * upstream behavior) or, with JEV_STATE_OVERFLOW_POLICY=trim, be trimmed to
 * the limit and still reach the decision provider.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTdaiConfig } from "../../config.js";
import { syncSceneIndex } from "../scene/scene-index.js";
import type { Logger } from "../types.js";
import { evaluateL3JevGate } from "./jev-gate.js";

const sceneFile = (summary: string, updated: string, body: string): string =>
  [
    "-----META-START-----",
    "created: 2026-01-01T00:00:00.000Z",
    `updated: ${updated}`,
    `summary: ${summary}`,
    "heat: 1",
    "-----META-END-----",
    "",
    body,
  ].join("\n");

const makeLogger = () => {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (message: string) => lines.push(`debug:${message}`),
    info: (message: string) => lines.push(`info:${message}`),
    warn: (message: string) => lines.push(`warn:${message}`),
    error: (message: string) => lines.push(`error:${message}`),
  };
  return { lines, logger };
};

const makeCfg = (): MemoryTdaiConfig =>
  ({
    persona: {
      triggerMode: "jev",
      jev: {
        provider: "jev",
        endpoint: "http://127.0.0.1:59999/mock",
        apiKey: "test-key",
        model: "jev-test",
        timeoutMs: 3_000,
        diagnostics: { mode: "off" },
      },
    },
  }) as unknown as MemoryTdaiConfig;

const makeFetcher = () => {
  const calls: string[] = [];
  const fetcher = (async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { state?: string };
    calls.push(String(body.state ?? ""));
    return new Response(
      JSON.stringify({
        model: "jev-test",
        answers: { memory_change: { choice: "new_rule", confidence: 0.9 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe("evaluateL3JevGate state overflow", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "jev-gate-overflow-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const seed = async (
    persona: string,
    scenes: Array<{ filename: string; summary: string; body: string }>,
  ): Promise<void> => {
    await writeFile(path.join(dir, "persona.md"), persona, "utf8");
    await mkdir(path.join(dir, "scene_blocks"), { recursive: true });
    for (const scene of scenes) {
      await writeFile(
        path.join(dir, "scene_blocks", scene.filename),
        sceneFile(scene.summary, "2026-10-15T00:00:00.000Z", scene.body),
        "utf8",
      );
    }
    await syncSceneIndex(dir);
  };

  it("trims an oversized state and still calls the provider when policy=trim", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "1500");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "trim");
    await seed("P".repeat(300), [{ filename: "big.md", summary: "big scene", body: "B".repeat(20_000) }]);

    const { lines, logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
    });

    expect(result.called).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBeLessThanOrEqual(1_500);
    expect(calls[0]).toContain("big.md");
    expect(calls[0]).toContain("big scene");
    expect(calls[0]).toContain("[... truncated");
    expect(lines.some((line) => line.startsWith("warn:") && line.includes("trimmed to"))).toBe(true);
  });

  it("keeps the upstream defer behavior when no policy is set", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "1500");
    await seed("P".repeat(300), [{ filename: "big.md", summary: "big scene", body: "B".repeat(20_000) }]);

    const { logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
    });

    expect(result.called).toBe(false);
    expect(result.reason).toBe("input_too_large");
    expect(calls).toHaveLength(0);
  });

  it("honors a raised JEV_STATE_LIMIT_CHARS without trimming", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "60000");
    await seed("P".repeat(1_000), [{ filename: "mid.md", summary: "mid scene", body: "B".repeat(33_000) }]);

    const { logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
    });

    expect(result.called).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBeGreaterThan(32_000);
    expect(calls[0]).not.toContain("[... truncated");
  });

  it("falls back to defer when trimming is infeasible", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "800");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "trim");
    await seed("P".repeat(2_000), [{ filename: "a.md", summary: "a", body: "small" }]);

    const { lines, logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
    });

    expect(result.called).toBe(false);
    expect(result.reason).toBe("input_too_large");
    expect(calls).toHaveLength(0);
    expect(lines.some((line) => line.includes("trim infeasible"))).toBe(true);
  });
});
