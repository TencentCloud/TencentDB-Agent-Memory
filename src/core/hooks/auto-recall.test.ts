/**
 * Tests for auto-recall's prependSystemContext (persona before CACHE_BOUNDARY).
 *
 * These tests verify the fix for #120 (secondary): persona + scene navigation
 * are placed in prependSystemContext (before CACHE_BOUNDARY, cacheable) instead
 * of appendSystemContext (after CACHE_BOUNDARY, uncached).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs with a default export matching `import fs from "node:fs/promises"`
vi.mock("node:fs/promises", () => {
  const mockReadFile = vi.fn();
  return {
    readFile: mockReadFile,
    default: { readFile: mockReadFile },
  };
});

vi.mock("node:path", async () => {
  const actual = await vi.importActual("node:path");
  return { ...actual };
});

import fs from "node:fs/promises";
import { performAutoRecall } from "./auto-recall.js";
import type { MemoryTdaiConfig } from "../../config.js";

const mockReadFile = vi.mocked(fs.readFile);

function makeConfig(overrides: Partial<MemoryTdaiConfig> = {}): MemoryTdaiConfig {
  return {
    chromadbHttpHost: "http://localhost:8000",
    chromadbCollectionPre: "tencentdb",
    enabled: true,
    recall: {
      strategy: "auto",
      similarityThreshold: 0.6,
      maxResults: 5,
      showInjected: false,
      ...overrides,
    },
    tenantdb: {},
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("auto-recall: prependSystemContext (fix #120 persona caching)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns prependSystemContext with persona when persona.md exists", async () => {
    mockReadFile.mockResolvedValue("I am a helpful AI assistant.");
    const logger = makeLogger();

    const result = await performAutoRecall({
      userText: "Hello",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger,
    });

    expect(result).toBeDefined();
    expect(result?.prependSystemContext).toBeDefined();
    expect(result?.prependSystemContext).toContain("<user-persona>");
    expect(result?.prependSystemContext).toContain("I am a helpful AI assistant.");
    expect(result?.prependSystemContext).toContain("</user-persona>");
  });

  it("excludes persona from appendSystemContext when persona.md exists", async () => {
    mockReadFile.mockResolvedValue("Test persona content.");
    const logger = makeLogger();

    const result = await performAutoRecall({
      userText: "Hello",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger,
    });

    expect(result?.prependSystemContext).toContain("Test persona content.");

    // appendSystemContext should NOT contain persona — only tools guide
    if (result?.appendSystemContext) {
      expect(result.appendSystemContext).not.toContain("<user-persona>");
      expect(result.appendSystemContext).not.toContain("Test persona content.");
    }
  });

  it("returns undefined all fields when no content to inject", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const logger = makeLogger();

    const result = await performAutoRecall({
      userText: "Hello",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger,
    });

    expect(result).toBeUndefined();
  });

  it("prependSystemContext is stable across identical persona files", async () => {
    const personaContent = "Consistent persona text for caching test.";
    mockReadFile.mockResolvedValue(personaContent);

    const result1 = await performAutoRecall({
      userText: "Query A",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger: makeLogger(),
    });

    vi.clearAllMocks();
    mockReadFile.mockResolvedValue(personaContent);

    const result2 = await performAutoRecall({
      userText: "Query B",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger: makeLogger(),
    });

    expect(result1?.prependSystemContext).toBe(result2?.prependSystemContext);
    expect(result1?.prependSystemContext).toBeDefined();
  });

  it("returns prependSystemContext even without memories", async () => {
    mockReadFile.mockResolvedValue("Persona only.");
    const logger = makeLogger();

    const result = await performAutoRecall({
      userText: "Hello",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger,
    });

    expect(result?.prependSystemContext).toBeDefined();
    expect(result?.prependContext).toBeUndefined(); // no memories
    expect(result?.appendSystemContext).toBeDefined(); // tools guide
  });

  it("prependSystemContext does NOT contain L1 dynamic memories", async () => {
    mockReadFile.mockResolvedValue("Persona.");
    const logger = makeLogger();

    const result = await performAutoRecall({
      userText: "Hello",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger,
    });

    if (result?.prependSystemContext) {
      expect(result.prependSystemContext).not.toContain("<relevant-memories>");
      expect(result.prependSystemContext).not.toContain("召回");
    }
  });

  it("diagnostic log includes prependSystemContext metrics", async () => {
    mockReadFile.mockResolvedValue("Test persona for diagnostics.");
    const logger = makeLogger();

    await performAutoRecall({
      userText: "Hello",
      actorId: "user1",
      sessionKey: "session1",
      cfg: makeConfig(),
      pluginDataDir: "/data",
      logger,
    });

    const debugCalls = logger.debug.mock.calls
      .map((c: any[]) => c[0])
      .join(" ");
    expect(debugCalls).toContain("prependSystemContext");
  });
});
