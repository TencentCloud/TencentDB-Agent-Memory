/**
 * Integration tests for the JEV gate `semantic` overflow policy.
 *
 * The semantic policy rewrites oversized scene bodies with a model instead of
 * chopping them positionally, so the decision still sees a faithful
 * description of every scene. It must fall back to the positional trim when
 * the rewrite cannot produce a usable body, and it must not change the
 * upstream defer behaviour when the policy is not selected.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTdaiConfig } from "../../config.js";
import { syncSceneIndex } from "../scene/scene-index.js";
import type { LLMRunner, Logger } from "../types.js";
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

describe("evaluateL3JevGate semantic overflow policy", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "jev-gate-semantic-"));
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

  const makeRunner = (reply: (prompt: string) => string): { runner: LLMRunner; prompts: string[] } => {
    const prompts: string[] = [];
    const runner: LLMRunner = {
      run: async (params) => {
        prompts.push(params.prompt);
        return reply(params.prompt);
      },
    };
    return { runner, prompts };
  };

  it("rewrites the oversized scene and calls the provider with the compressed body", async () => {
    // The raw state (~12.5k) exceeds the limit; the rewritten state (~11.7k)
    // fits, so no positional trim is needed. The body is rewritten in chunks,
    // so the model is asked once per chunk.
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "12000");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "semantic");
    vi.stubEnv("JEV_SEMANTIC_CHUNK_CHARS", "4000");
    // A body with real section structure, so it splits into several chunks.
    const sections = ["## 甲", "## 乙", "## 丙", "## 丁"]
      .map((h) => `${h}\n${"内容。".repeat(1_000)}`)
      .join("\n");
    await seed("P".repeat(300), [{ filename: "big.md", summary: "big scene", body: sections }]);

    // A realistic rewrite keeps roughly half of the chunk it was given.
    const compressed = "## 压缩\n保留的有效事实。".repeat(100);
    const { runner, prompts } = makeRunner(() => compressed);
    const { lines, logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
      llmRunner: runner,
    });

    expect(result.called).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBeLessThanOrEqual(20_000);
    // The scene metadata survives and the body was replaced, not chopped.
    expect(calls[0]).toContain("big.md");
    expect(calls[0]).toContain("big scene");
    expect(calls[0]).toContain("保留的有效事实。");
    expect(calls[0]).not.toContain("[... truncated");
    // The model was asked to rewrite this exact scene, one chunk at a time.
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[0]).toContain("big.md");
    expect(lines.some((line) => line.includes("semantic compression rewrote 1 scene"))).toBe(true);
  });

  it("falls back to the positional trim when the rewrite is not usable", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "1500");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "semantic");
    await seed("P".repeat(300), [{ filename: "big.md", summary: "big scene", body: "B".repeat(20_000) }]);

    // Too short to be a faithful rewrite — rejected by the validator.
    const { runner } = makeRunner(() => "短。");
    const { lines, logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
      llmRunner: runner,
    });

    expect(result.called).toBe(true);
    expect(calls[0].length).toBeLessThanOrEqual(1_500);
    expect(calls[0]).toContain("[... truncated");
    expect(lines.some((line) => line.includes("trimmed to"))).toBe(true);
  });

  it("falls back to the positional trim when the model call throws", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "1500");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "semantic");
    await seed("P".repeat(300), [{ filename: "big.md", summary: "big scene", body: "B".repeat(20_000) }]);

    const runner: LLMRunner = {
      run: async () => {
        throw new Error("provider down");
      },
    };
    const { lines, logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
      llmRunner: runner,
    });

    expect(result.called).toBe(true);
    expect(calls[0].length).toBeLessThanOrEqual(1_500);
    expect(calls[0]).toContain("[... truncated");
    expect(lines.some((line) => line.includes("trimmed to"))).toBe(true);
  });

  it("falls back to the positional trim when no runner is available", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "1500");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "semantic");
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

    expect(result.called).toBe(true);
    expect(calls[0].length).toBeLessThanOrEqual(1_500);
    expect(calls[0]).toContain("[... truncated");
  });

  it("keeps the upstream defer behavior when the policy is not selected", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "1500");
    await seed("P".repeat(300), [{ filename: "big.md", summary: "big scene", body: "B".repeat(20_000) }]);

    const { runner } = makeRunner(() => "## 压缩\n内容。");
    const { logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
      llmRunner: runner,
    });

    expect(result.called).toBe(false);
    expect(result.reason).toBe("input_too_large");
    expect(calls).toHaveLength(0);
  });

  it("does not call the model when the state already fits", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "60000");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "semantic");
    await seed("P".repeat(100), [{ filename: "small.md", summary: "small scene", body: "short body" }]);

    const { runner, prompts } = makeRunner(() => "never");
    const { logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
      llmRunner: runner,
    });

    expect(result.called).toBe(true);
    expect(prompts).toHaveLength(0);
    expect(calls[0]).not.toContain("[... truncated");
  });

  it("defers when neither the semantic pass nor the trim can fit", async () => {
    vi.stubEnv("JEV_STATE_LIMIT_CHARS", "800");
    vi.stubEnv("JEV_STATE_OVERFLOW_POLICY", "semantic");
    await seed("P".repeat(2_000), [{ filename: "a.md", summary: "a", body: "small" }]);

    const { runner } = makeRunner(() => "## 压缩\n内容。");
    const { lines, logger } = makeLogger();
    const { calls, fetcher } = makeFetcher();
    const result = await evaluateL3JevGate({
      dataDir: dir,
      cfg: makeCfg(),
      logger,
      triggerReason: "test",
      fetcher,
      llmRunner: runner,
    });

    expect(result.called).toBe(false);
    expect(result.reason).toBe("input_too_large");
    expect(calls).toHaveLength(0);
    expect(lines.some((line) => line.includes("semantic + trim infeasible"))).toBe(true);
  });
});
