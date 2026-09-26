/**
 * Tests for the ClaudeCodeAdapter — focusing on the 4 abstract methods
 * that are platform-specific: formatRecallResult, getToolDefinitions,
 * formatToolResult, normalizeMessages.
 *
 * These tests do NOT require a running Gateway — they test only the
 * formatting and normalization logic that is unique to the Claude Code
 * platform adapter.
 */

import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";
import type { RecallResult, SearchResult, MemoryItem, PersonaContent, SceneEntry } from "../sdk/types.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeRecallResult(overrides?: Partial<RecallResult>): RecallResult {
  return {
    prependContext: "",
    appendSystemContext: "",
    memories: [],
    persona: null,
    scenes: [],
    latencyMs: 42,
    ...overrides,
  };
}

const sampleMemories: MemoryItem[] = [
  { type: "persona", content: "Prefers dark mode", score: 0.952 },
  { type: "episodic", content: "Discussed React state management", score: 0.871 },
  { type: "instruction", content: "Always use functional components", score: 0.763 },
];

const samplePersona: PersonaContent = {
  content: "Alice is a senior frontend developer who values clean code.",
  updatedAt: "2024-03-15T10:00:00Z",
};

const sampleScenes: SceneEntry[] = [
  { path: "scene_blocks/travel-plan.md", summary: "Summer vacation planning", heat: 3 },
  { path: "scene_blocks/project-setup.md", summary: "React project initialization" },
];

// ── Tests ──────────────────────────────────────────────────────────

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  describe("platformName", () => {
    it("should be 'claude-code'", () => {
      expect(adapter.platformName).toBe("claude-code");
    });
  });

  // ── formatRecallResult ──────────────────────────────────────────

  describe("formatRecallResult", () => {
    it("should format L1 memories as XML-tagged block in prependContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ memories: sampleMemories }),
      );

      expect(result.prependContext).toBeDefined();
      expect(result.prependContext!).toContain("<relevant-memories>");
      expect(result.prependContext!).toContain("</relevant-memories>");
      expect(result.prependContext!).toContain("[persona]");
      expect(result.prependContext!).toContain("Prefers dark mode");
      expect(result.prependContext!).toContain("(score: 0.952)");
      expect(result.prependContext!).toContain("[episodic]");
      expect(result.prependContext!).toContain("[instruction]");
    });

    it("should format L3 persona in appendSystemContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ persona: samplePersona }),
      );

      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("<user-persona>");
      expect(result.appendSystemContext!).toContain("Alice is a senior frontend developer");
    });

    it("should format L2 scenes in appendSystemContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ scenes: sampleScenes }),
      );

      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("<scene-navigation>");
      expect(result.appendSystemContext!).toContain("scene_blocks/travel-plan.md");
      expect(result.appendSystemContext!).toContain("Summer vacation planning");
      expect(result.appendSystemContext!).toContain("tdai_read_scene");
    });

    it("should include memory tools guide in appendSystemContext when memories exist", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ memories: sampleMemories }),
      );

      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("<memory-tools-guide>");
      expect(result.appendSystemContext!).toContain("tdai_memory_search");
      expect(result.appendSystemContext!).toContain("tdai_conversation_search");
      expect(result.appendSystemContext!).toContain("tdai_read_scene");
    });

    it("should return empty prependContext but include tools guide when no data", () => {
      const result = adapter.formatRecallResult(makeRecallResult());

      expect(result.prependContext).toBeFalsy();
      // Claude Code always includes the memory tools guide in appendSystemContext
      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("<memory-tools-guide>");
    });

    it("should handle single memory without score", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({
          memories: [{ type: "episodic", content: "No score memory" }],
        }),
      );

      expect(result.prependContext).toContain("No score memory");
      expect(result.prependContext).not.toContain("score:");
    });

    it("should combine persona and scenes in appendSystemContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ persona: samplePersona, scenes: sampleScenes }),
      );

      expect(result.appendSystemContext).toContain("<user-persona>");
      expect(result.appendSystemContext).toContain("<scene-navigation>");
      // Persona should come before scenes
      expect(
        result.appendSystemContext!.indexOf("<user-persona>"),
      ).toBeLessThan(result.appendSystemContext!.indexOf("<scene-navigation>"));
    });
  });

  // ── getToolDefinitions ──────────────────────────────────────────

  describe("getToolDefinitions", () => {
    it("should return 3 tool definitions", () => {
      const tools = adapter.getToolDefinitions();
      expect(tools).toHaveLength(3);
    });

    it("should include tdai_memory_search tool", () => {
      const tools = adapter.getToolDefinitions();
      const searchTool = tools.find((t) => t.name === "tdai_memory_search");
      expect(searchTool).toBeDefined();
      expect(searchTool!.description).toContain("memories");
      expect(searchTool!.parameters.required).toContain("query");
    });

    it("should include tdai_conversation_search tool", () => {
      const tools = adapter.getToolDefinitions();
      const convTool = tools.find((t) => t.name === "tdai_conversation_search");
      expect(convTool).toBeDefined();
      expect(convTool!.parameters.required).toContain("query");
    });

    it("should include tdai_read_scene tool", () => {
      const tools = adapter.getToolDefinitions();
      const sceneTool = tools.find((t) => t.name === "tdai_read_scene");
      expect(sceneTool).toBeDefined();
      expect(sceneTool!.parameters.required).toContain("scene_id");
    });

    it("should have valid JSON Schema for all tools", () => {
      const tools = adapter.getToolDefinitions();
      for (const tool of tools) {
        expect(tool.parameters.type).toBe("object");
        expect(tool.parameters.properties).toBeDefined();
        expect(typeof tool.parameters.properties).toBe("object");
      }
    });
  });

  // ── formatToolResult ────────────────────────────────────────────

  describe("formatToolResult", () => {
    it("should format memory search results as plain text", () => {
      const searchResult: SearchResult = {
        text: "",
        total: 2,
        items: sampleMemories.slice(0, 2),
      };

      const formatted = adapter.formatToolResult("tdai_memory_search", searchResult);
      expect(formatted).toContain("[persona]");
      expect(formatted).toContain("Prefers dark mode");
      expect(formatted).toContain("[episodic]");
    });

    it("should return 'No memories found' for empty search", () => {
      const searchResult: SearchResult = {
        text: "",
        total: 0,
        items: [],
      };

      const formatted = adapter.formatToolResult("tdai_memory_search", searchResult);
      expect(formatted).toContain("No memories");
    });

    it("should pass through string results (scene content)", () => {
      const sceneContent = "# Travel Plan\n\nDestination: Japan\nDates: July 2024";
      const formatted = adapter.formatToolResult("tdai_read_scene", sceneContent);
      expect(formatted).toBe(sceneContent);
    });

    it("should format conversation search results", () => {
      const searchResult: SearchResult = {
        text: "",
        total: 1,
        items: [{ type: "conversation", content: "User said hello at 10am", score: 0.85 }],
      };

      const formatted = adapter.formatToolResult("tdai_conversation_search", searchResult);
      expect(formatted).toContain("User said hello");
    });
  });

  // ── normalizeMessages ───────────────────────────────────────────

  describe("normalizeMessages", () => {
    it("should normalize simple string content messages", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Hi there");
    });

    it("should normalize content block arrays (text type)", () => {
      const messages = adapter.normalizeMessages([
        {
          role: "user",
          content: [{ type: "text", text: "Hello from blocks" }],
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello from blocks");
    });

    it("should extract text from tool_use blocks", () => {
      const messages = adapter.normalizeMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search" },
            { type: "tool_use", name: "tdai_memory_search", input: { query: "test" } },
          ],
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("Let me search");
      expect(messages[0].content).toContain("tdai_memory_search");
    });

    it("should extract text from tool_result blocks", () => {
      const messages = adapter.normalizeMessages([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "123", content: "Search result data" },
          ],
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("Search result data");
    });

    it("should skip messages with null/undefined content", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: null },
        { role: "assistant", content: "Valid" },
        { role: "user", content: undefined },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Valid");
    });

    it("should skip non-object messages", () => {
      const messages = adapter.normalizeMessages([
        "invalid",
        null,
        42,
        { role: "user", content: "Valid" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Valid");
    });

    it("should return empty array for non-array input", () => {
      expect(adapter.normalizeMessages(null)).toEqual([]);
      expect(adapter.normalizeMessages(undefined)).toEqual([]);
      expect(adapter.normalizeMessages("string")).toEqual([]);
      expect(adapter.normalizeMessages(42)).toEqual([]);
    });

    it("should use context timestamp as default when message has no timestamp", () => {
      const messages = adapter.normalizeMessages(
        [{ role: "user", content: "Hello" }],
        { timestamp: "2024-01-15T10:00:00Z" },
      );

      expect(messages[0].timestamp).toBe("2024-01-15T10:00:00Z");
    });

    it("should preserve provided timestamps", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: "Hello", timestamp: "2024-01-15T10:00:00Z" },
      ]);

      expect(messages[0].timestamp).toBe("2024-01-15T10:00:00Z");
    });
  });
});
