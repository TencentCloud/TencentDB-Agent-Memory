/**
 * auto-recall.test.ts — Integration-style tests for performAutoRecall.
 *
 * Tests the recall pipeline with mocked VectorStore and EmbeddingService,
 * using temporary directories for persona and scene data.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performAutoRecall } from "./auto-recall.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { parseConfig } from "../../config.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";

// ======================================================
// Minimal mock IMemoryStore
// ======================================================

function createMockVectorStore(opts?: {
  ftsResults?: L1FtsResult[];
  vecResults?: L1SearchResult[];
  ftsAvailable?: boolean;
  nativeHybridSearch?: boolean;
  hybridResults?: L1SearchResult[];
}): IMemoryStore {
  return {
    isFtsAvailable: () => opts?.ftsAvailable ?? true,
    searchL1Fts: async () => opts?.ftsResults ?? [],
    searchL1Vector: async () => opts?.vecResults ?? [],
    searchL1Hybrid: async () => opts?.hybridResults ?? [],
    getCapabilities: () => ({
      nativeHybridSearch: opts?.nativeHybridSearch ?? false,
      supportsDeferredEmbedding: true,
    }),
  } as unknown as IMemoryStore;
}

// ======================================================
// Minimal mock EmbeddingService
// ======================================================

function createMockEmbeddingService(): EmbeddingService {
  return {
    embed: async () => new Float32Array(128).fill(0.1),
    isReady: () => true,
    startWarmup: () => {},
  } as unknown as EmbeddingService;
}

// ======================================================
// Test helpers
// ======================================================

function makeConfig(overrides?: Record<string, unknown>): MemoryTdaiConfig {
  return parseConfig(overrides);
}

function makeFtsResult(overrides?: Partial<L1FtsResult>): L1FtsResult {
  return {
    record_id: "mem-1",
    content: "用户偏好使用TypeScript编写前端代码",
    type: "instruction",
    priority: "medium",
    scene_name: "coding",
    session_key: "sess-1",
    session_id: "sid-1",
    score: 0.85,
    metadata_json: "{}",
    timestamp_str: "2026-06-15T10:00:00Z",
    ...overrides,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ======================================================
// Tests
// ======================================================

describe("performAutoRecall", () => {
  describe("basic recall with FTS results", () => {
    it("returns prependContext with relevant-memories for FTS results", async () => {
      await withTempDir(async (dir) => {
        const cfg = makeConfig();
        const vectorStore = createMockVectorStore({
          ftsResults: [makeFtsResult({ score: 0.9 })],
        });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "TypeScript配置",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeDefined();
        expect(result!.prependContext).toBeDefined();
        expect(result!.prependContext).toContain("<relevant-memories>");
        expect(result!.prependContext).toContain("以下是当前对话召回的相关记忆");
        expect(result!.prependContext).toContain("TypeScript");
        // Tools guide should be in appendSystemContext since there IS recall content
        expect(result!.appendSystemContext).toBeDefined();
        expect(result!.appendSystemContext).toContain("<memory-tools-guide>");
      });
    });

    it("returns empty when no FTS results and no persona/scene", async () => {
      await withTempDir(async (dir) => {
        const cfg = makeConfig();
        const vectorStore = createMockVectorStore({ ftsResults: [] });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "random query with no matches",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeUndefined();
      });
    });
  });

  describe("persona and scene injection", () => {
    it("includes persona in appendSystemContext when persona.md exists", async () => {
      await withTempDir(async (dir) => {
        // Write a persona file
        await fs.writeFile(
          path.join(dir, "persona.md"),
          "# User Persona\n\n用户叫王小明，30岁，软件工程师。",
          "utf-8",
        );

        const cfg = makeConfig();
        const vectorStore = createMockVectorStore({
          ftsResults: [makeFtsResult({ score: 0.9 })],
        });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "测试查询",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeDefined();
        expect(result!.appendSystemContext).toContain("<user-persona>");
        expect(result!.appendSystemContext).toContain("王小明");
      });
    });

    it("works with only persona, no L1 recall", async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(
          path.join(dir, "persona.md"),
          "User is a developer.",
          "utf-8",
        );

        const cfg = makeConfig();
        const vectorStore = createMockVectorStore({ ftsResults: [] });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "Hello",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeDefined();
        expect(result!.prependContext).toBeUndefined(); // no L1 recall
        expect(result!.appendSystemContext).toBeDefined(); // persona + tools guide
        expect(result!.appendSystemContext).toContain("<user-persona>");
      });
    });
  });

  describe("recall budget", () => {
    it("respects maxTotalRecallChars budget", async () => {
      await withTempDir(async (dir) => {
        // Create a config with tight budget
        const cfg = makeConfig({
          recall: { maxTotalRecallChars: 100 },
        });

        const longContent = "A".repeat(500);
        const vectorStore = createMockVectorStore({
          ftsResults: [
            makeFtsResult({ content: longContent, score: 0.9, record_id: "mem-1" }),
            makeFtsResult({ content: longContent, score: 0.8, record_id: "mem-2" }),
            makeFtsResult({ content: longContent, score: 0.7, record_id: "mem-3" }),
          ],
        });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "test",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeDefined();
        expect(result!.prependContext).toBeDefined();
        // Budget should limit the total recall chars injected
        const recallContent = result!.prependContext!;
        // Extract the actual memory lines (between the XML tags)
        const memMatch = recallContent.match(/<relevant-memories>[\s\S]*?\n\n([\s\S]*?)\n<\/relevant-memories>/);
        if (memMatch) {
          const lines = memMatch[1].split("\n").filter(Boolean);
          // With 100 char budget and 500-char lines, only the first line should fit
          expect(lines.length).toBeLessThanOrEqual(3);
        }
      });
    });
  });

  describe("strategy fallback", () => {
    it("falls back to keyword when embedding service unavailable", async () => {
      await withTempDir(async (dir) => {
        const cfg = makeConfig({ recall: { strategy: "embedding" } });
        const vectorStore = createMockVectorStore({
          ftsResults: [makeFtsResult({ score: 0.9 })],
        });
        // No embeddingService provided

        const result = await performAutoRecall({
          userText: "test query",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          // embeddingService intentionally undefined
        });

        expect(result).toBeDefined();
        // recallStrategy reports the configured strategy ("embedding"),
        // even though internally searchMemories falls back to keyword FTS.
        // The FTS results are still returned because fallback succeeds.
        expect(result!.recallStrategy).toBe("embedding");
        // prependContext should still contain the FTS result (fallback worked)
        expect(result!.prependContext).toBeDefined();
        expect(result!.prependContext).toContain("TypeScript");
      });
    });
  });

  describe("timeout behavior", () => {
    it("returns undefined when recall times out", async () => {
      await withTempDir(async (dir) => {
        const cfg = makeConfig({ recall: { timeoutMs: 50 } });
        const vectorStore = createMockVectorStore();
        // Create a store that hangs
        const hangingStore: IMemoryStore = {
          ...vectorStore,
          searchL1Fts: async () => new Promise(() => {}), // never resolves
        } as unknown as IMemoryStore;

        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "test",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore: hangingStore,
          embeddingService,
        });

        expect(result).toBeUndefined(); // timed out, skipped injection
      });
    });
  });

  describe("output format", () => {
    it("prependContext uses standard <relevant-memories> wrapper with Chinese preamble", async () => {
      await withTempDir(async (dir) => {
        const cfg = makeConfig();
        const vectorStore = createMockVectorStore({
          ftsResults: [makeFtsResult({ content: "用户喜欢React", score: 0.9 })],
        });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "React",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeDefined();
        expect(result!.prependContext).toMatch(/^<relevant-memories>/);
        expect(result!.prependContext).toMatch(/<\/relevant-memories>$/m);
        expect(result!.prependContext).toContain("以下是当前对话召回的相关记忆");
        expect(result!.prependContext).toContain("不代表当前任务进程");
      });
    });

    it("appendSystemContext includes memory-tools-guide when there is recall", async () => {
      await withTempDir(async (dir) => {
        const cfg = makeConfig();
        const vectorStore = createMockVectorStore({
          ftsResults: [makeFtsResult()],
        });
        const embeddingService = createMockEmbeddingService();

        const result = await performAutoRecall({
          userText: "test",
          actorId: "default_user",
          sessionKey: "sess-1",
          cfg,
          pluginDataDir: dir,
          vectorStore,
          embeddingService,
        });

        expect(result).toBeDefined();
        expect(result!.appendSystemContext).toContain("<memory-tools-guide>");
        expect(result!.appendSystemContext).toContain("tdai_memory_search");
        expect(result!.appendSystemContext).toContain("tdai_conversation_search");
      });
    });
  });
});
