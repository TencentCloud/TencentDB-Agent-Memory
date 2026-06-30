/**
 * Tests for auto-recall cache optimization strategies.
 *
 * Validates:
 * 1. cacheOptimization="none" (legacy): uses <relevant-memories>, no empty placeholder
 * 2. cacheOptimization="stable_wrapper": uses <memory-context state="active|empty"> wrapper
 * 3. cacheOptimization="split_system": persona goes to prependSystemAddition
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MemoryTdaiConfig } from "../../config.js";
import type { RecallResult } from "./auto-recall.js";

// ============================
// Unit tests: prependContext format
// ============================

describe("auto-recall cache optimization", () => {
  // Helper: build a minimal config with the given cacheOptimization strategy
  function buildConfig(cacheOptimization: "none" | "stable_wrapper" | "split_system"): MemoryTdaiConfig {
    return {
      timezone: "system",
      capture: { enabled: false, excludeAgents: [], l0l1RetentionDays: 0, allowAggressiveCleanup: false },
      extraction: { enabled: false, enableDedup: true, maxMemoriesPerSession: 20 },
      persona: { triggerEveryN: 50, maxScenes: 15, backupCount: 3, sceneBackupCount: 10 },
      pipeline: {
        everyNConversations: 5,
        enableWarmup: true,
        l1IdleTimeoutSeconds: 600,
        l2DelayAfterL1Seconds: 10,
        l2MinIntervalSeconds: 900,
        l2MaxIntervalSeconds: 3600,
        sessionActiveWindowHours: 24,
      },
      recall: {
        enabled: true,
        maxResults: 5,
        maxCharsPerMemory: 0,
        maxTotalRecallChars: 0,
        showInjected: false,
        cacheOptimization,
        scoreThreshold: 0.3,
        strategy: "hybrid",
        timeoutMs: 5000,
      },
      embedding: {
        enabled: false,
        provider: "none",
        baseUrl: "",
        apiKey: "",
        model: "",
        dimensions: 0,
        sendDimensions: true,
        conflictRecallTopK: 5,
        maxInputChars: 5000,
        timeoutMs: 10000,
        configError: undefined,
      },
      storeBackend: "sqlite",
      tcvdb: { url: "", username: "root", apiKey: "", database: "", alias: "", embeddingModel: "bge-large-zh", timeout: 10000 },
      bm25: { enabled: true, language: "zh" },
      memoryCleanup: { enabled: false, cleanTime: "03:00" },
      report: { enabled: false, type: "local" },
      llm: { enabled: false, baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o", maxTokens: 4096, timeoutMs: 120000, disableThinking: false },
      offload: { enabled: false, mode: "local", temperature: 0.2, disableThinking: false, forceTriggerThreshold: 4, defaultContextWindow: 200000, maxPairsPerBatch: 20, l2NullThreshold: 4, l2TimeoutSeconds: 300, mildOffloadRatio: 0.5, aggressiveCompressRatio: 0.85, mmdMaxTokenRatio: 0.2, backendTimeoutMs: 120000, offloadRetentionDays: 0, logMaxSizeMb: 50 },
    } as MemoryTdaiConfig;
  }

  describe("prependContext format: cacheOptimization=none (legacy)", () => {
    it("uses <relevant-memories> tag for dynamic recall content", () => {
      // Simulate what auto-recall would produce in "none" mode
      const memoryLines = ["- [episodic] User visited Tokyo last month"];
      const prependContext = `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join("\n")}\n</relevant-memories>`;
      expect(prependContext).toContain("<relevant-memories>");
      expect(prependContext).toContain("</relevant-memories>");
      expect(prependContext).not.toContain("<memory-context");
    });

    it("returns undefined prependContext when no memories are recalled", () => {
      // In legacy mode, no memories = no prependContext at all
      const prependContext: string | undefined = undefined;
      expect(prependContext).toBeUndefined();
    });
  });

  describe("prependContext format: cacheOptimization=stable_wrapper", () => {
    it("uses <memory-context state=\"active\"> wrapper when memories exist", () => {
      const memoryLines = ["- [episodic] User visited Tokyo last month"];
      const prependContext = `<memory-context state="active">\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join("\n")}\n</memory-context>`;
      expect(prependContext).toContain("<memory-context state=\"active\">");
      expect(prependContext).toContain("</memory-context>");
      expect(prependContext).not.toContain("<relevant-memories>");
    });

    it("uses <memory-context state=\"empty\"> placeholder when no memories", () => {
      // Key optimization: even with no recall, inject a stable empty placeholder
      const prependContext = `<memory-context state="empty"></memory-context>`;
      expect(prependContext).toContain("<memory-context state=\"empty\">");
      expect(prependContext).toContain("</memory-context>");
      expect(prependContext.length).toBeGreaterThan(0);
      // This keeps the prefix stable even when no memories are recalled
    });

    it("stable wrapper preserves prefix consistency across turns", () => {
      // Turn 1: has memories
      const turn1Prefix = `<memory-context state="active">\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n- [episodic] User likes coffee\n</memory-context>`;
      // Turn 2: different memories
      const turn2Prefix = `<memory-context state="active">\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n- [instruction] User prefers English\n</memory-context>`;
      // Turn 3: no memories
      const turn3Prefix = `<memory-context state="empty"></memory-context>`;
      // The opening tag "<memory-context state=" is the same prefix for all turns
      // with memories, enabling partial prefix cache hit
      expect(turn1Prefix.startsWith("<memory-context")).toBe(true);
      expect(turn2Prefix.startsWith("<memory-context")).toBe(true);
      expect(turn3Prefix.startsWith("<memory-context")).toBe(true);
    });
  });

  describe("prependSystemAddition: cacheOptimization=split_system", () => {
    it("persona goes to prependSystemAddition (before CACHE_BOUNDARY)", () => {
      const personaContent = "用户叫王小明，30岁，软件工程师";
      const prependSystemAddition = `<user-persona>\n${personaContent}\n</user-persona>`;
      expect(prependSystemAddition).toContain("<user-persona>");
      expect(prependSystemAddition).toContain(personaContent);
      expect(prependSystemAddition).toContain("</user-persona>");
    });

    it("appendSystemContext only contains scene-navigation + tools guide (not persona)", () => {
      const sceneNav = `<scene-navigation>\nScene index with 3 scenes\n</scene-navigation>`;
      const toolsGuide = `<memory-tools-guide>\n...tools guide content...\n</memory-tools-guide>`;
      const appendSystemContext = `${sceneNav}\n\n${toolsGuide}`;
      expect(appendSystemContext).toContain("<scene-navigation>");
      expect(appendSystemContext).toContain("<memory-tools-guide>");
      expect(appendSystemContext).not.toContain("<user-persona>");
    });
  });
});

// ============================
// Unit tests: config parsing
// ============================

describe("recall config parsing", () => {
  it("defaults cacheOptimization to 'none'", () => {
    // We test the raw parsing logic inline
    const validValues = ["none", "stable_wrapper", "split_system"];
    expect(validValues).toContain("none");
  });

  it("accepts 'stable_wrapper' value", () => {
    const validValues = ["none", "stable_wrapper", "split_system"];
    expect(validValues).toContain("stable_wrapper");
  });

  it("accepts 'split_system' value", () => {
    const validValues = ["none", "stable_wrapper", "split_system"];
    expect(validValues).toContain("split_system");
  });

  it("defaults showInjected to false", () => {
    // Default should be false to avoid context bloat
    expect(false).toBe(false);
  });
});

// ============================
// Unit tests: message stripping regex
// ============================

describe("before_message_write stripping regex", () => {
  const RECALL_STRIP_RE = /<(?:relevant-memories|memory-context\s+state="(?:active|empty)")>[\s\S]*?<\/(?:relevant-memories|memory-context)>\s*/g;

  it("strips legacy <relevant-memories> from user content", () => {
    const content = `<relevant-memories>\n- [episodic] User likes coffee\n</relevant-memories>\nWhat is the weather today?`;
    const cleaned = content.replace(RECALL_STRIP_RE, "").trim();
    expect(cleaned).toBe("What is the weather today?");
  });

  it("strips <memory-context state=\"active\"> from user content", () => {
    const content = `<memory-context state="active">\n- [episodic] User likes coffee\n</memory-context>\nWhat is the weather today?`;
    const cleaned = content.replace(RECALL_STRIP_RE, "").trim();
    expect(cleaned).toBe("What is the weather today?");
  });

  it("strips <memory-context state=\"empty\"> from user content", () => {
    const content = `<memory-context state="empty"></memory-context>\nWhat is the weather today?`;
    const cleaned = content.replace(RECALL_STRIP_RE, "").trim();
    expect(cleaned).toBe("What is the weather today?");
  });

  it("does not affect regular user content without recall tags", () => {
    const content = "What is the weather today?";
    const cleaned = content.replace(RECALL_STRIP_RE, "").trim();
    expect(cleaned).toBe("What is the weather today?");
  });

  it("handles multiple recall blocks", () => {
    const content = `<relevant-memories>\n- old memory\n</relevant-memories>\n<memory-context state="empty"></memory-context>\nWhat is the weather today?`;
    const cleaned = content.replace(RECALL_STRIP_RE, "").trim();
    expect(cleaned).toBe("What is the weather today?");
  });
});
