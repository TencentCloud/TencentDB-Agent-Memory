/**
 * Tests for #417 — explicit durable-memory ingest. Mirrors host-native memory
 * writes directly into the searchable L1 index (VectorStore write required),
 * with target-based classification.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestExplicitMemory } from "./explicit-memory.js";
import type { IMemoryStore } from "../store/types.js";

function makeStore(opts: { upsertOk?: boolean } = {}): IMemoryStore {
  const upsertOk = opts.upsertOk ?? true;
  return {
    upsertL1: async () => upsertOk,
    deleteL1: async () => true,
    deleteL1Batch: async () => true,
    deleteL1Expired: async () => 0,
    queryL1Records: async () => [],
    countL1: async () => 0,
    getAllL1Texts: async () => [],
    searchL1Vector: async () => [],
    searchL1Fts: async () => [],
    upsertL0: async () => true,
    deleteL0: async () => true,
    deleteL0Expired: async () => 0,
    queryL0ForL1: async () => [],
    queryL0GroupedBySessionId: async () => [],
    getAllL0Texts: async () => [],
    searchL0Vector: async () => [],
    searchL0Fts: async () => [],
    reindexAll: async () => ({ l1Count: 0, l0Count: 0 }),
    init: async () => ({ ok: true }),
    isDegraded: () => false,
    getCapabilities: () => ({ supportsVector: true, supportsFts: false }),
    close: () => {},
  } as unknown as IMemoryStore;
}

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "explicit-memory-417-"));
}

describe("ingestExplicitMemory (#417)", () => {
  it("stores an 'add' memory into the vector store with an id and type", async () => {
    const baseDir = tempDir();
    try {
      const store = makeStore();
      const record = await ingestExplicitMemory({
        action: "add",
        target: "memory",
        content: "TencentDB retry probe memory: durable memory round-trip verification marker.",
        baseDir,
        sessionKey: "sess-1",
        sessionId: "sess-1",
        logger,
        vectorStore: store,
        embeddingService: { embed: async () => new Float32Array(8) } as never,
      });

      expect(record).not.toBeNull();
      expect(record!.content).toContain("TencentDB retry probe");
      expect(record!.type).toBe("instruction");
      expect(record!.scene_name).toBe("hermes_explicit_memory");
      expect(record!.id).toBeTruthy();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("classifies user/profile targets as persona", async () => {
    const baseDir = tempDir();
    try {
      const store = makeStore();
      const record = await ingestExplicitMemory({
        action: "add",
        target: "user",
        content: "I prefer Rust for systems work.",
        baseDir,
        sessionKey: "sess-1",
        sessionId: "sess-1",
        logger,
        vectorStore: store,
        embeddingService: { embed: async () => new Float32Array(8) } as never,
      });

      expect(record!.type).toBe("persona");
      expect(record!.scene_name).toBe("hermes_user_profile");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("returns null for non-add actions and empty content", async () => {
    const baseDir = tempDir();
    try {
      const store = makeStore();
      const noAdd = await ingestExplicitMemory({
        action: "delete", target: "memory", content: "x",
        baseDir, sessionKey: "s", logger, vectorStore: store,
      });
      const empty = await ingestExplicitMemory({
        action: "add", target: "memory", content: "   ",
        baseDir, sessionKey: "s", logger, vectorStore: store,
      });
      expect(noAdd).toBeNull();
      expect(empty).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("returns null when no vector store is available (must be searchable)", async () => {
    const baseDir = tempDir();
    try {
      const record = await ingestExplicitMemory({
        action: "add", target: "memory", content: "must be searchable",
        baseDir, sessionKey: "s", logger,
        // no vectorStore → requireVectorStoreWrite rejects the write
      });
      expect(record).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("returns null when the vector store upsert fails", async () => {
    const baseDir = tempDir();
    try {
      const store = makeStore({ upsertOk: false });
      const record = await ingestExplicitMemory({
        action: "add", target: "memory", content: "upsert will fail",
        baseDir, sessionKey: "s", logger,
        vectorStore: store,
        embeddingService: { embed: async () => new Float32Array(8) } as never,
      });
      expect(record).toBeNull();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
