/**
 * Tests for the CodexAdapter — focusing on the 4 abstract methods
 * that are platform-specific: formatRecallResult, getToolDefinitions,
 * formatToolResult, normalizeMessages.
 *
 * These tests do NOT require a running Gateway — they test only the
 * formatting and normalization logic unique to the Codex platform.
 */

import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type {
  RecallResult,
  SearchResult,
  MemoryItem,
  PersonaContent,
  SceneEntry,
} from "../sdk/types.js";

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
  { path: "travel-plan.md", summary: "Summer vacation planning", heat: 3 },
  { path: "project-setup.md", summary: "React project initialization" },
];

// ── Tests ──────────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  const adapter = new CodexAdapter();

  describe("platformName", () => {
    it("should be 'codex'", () => {
      expect(adapter.platformName).toBe("codex");
    });
  });

  // ── formatRecallResult ──────────────────────────────────────────

  describe("formatRecallResult", () => {
    it("should format L1 memories as Markdown in prependContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ memories: sampleMemories }),
      );

      expect(result.prependContext).toBeDefined();
      expect(result.prependContext!).toContain("## Relevant Memories");
      expect(result.prependContext!).toContain("**[persona]**");
      expect(result.prependContext!).toContain("Prefers dark mode");
      expect(result.prependContext!).toContain("(score: 0.95)");
      expect(result.prependContext!).toContain("**[episodic]**");
      expect(result.prependContext!).toContain("**[instruction]**");
    });

    it("should include disclaimer text in prependContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ memories: sampleMemories }),
      );

      expect(result.prependContext).toContain("contextual references only");
    });

    it("should format L3 persona as Markdown in appendSystemContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ persona: samplePersona }),
      );

      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("## User Persona");
      expect(result.appendSystemContext!).toContain("Alice is a senior frontend developer");
    });

    it("should format L2 scenes as Markdown in appendSystemContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ scenes: sampleScenes }),
      );

      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("## Scene Navigation");
      expect(result.appendSystemContext!).toContain("travel-plan.md");
      expect(result.appendSystemContext!).toContain("Summer vacation planning");
      expect(result.appendSystemContext!).toContain("tdai_read_scene");
    });

    it("should include heat score in scene listing", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ scenes: sampleScenes }),
      );

      expect(result.appendSystemContext).toContain("heat: 3");
    });

    it("should include memory tools section when persona or scenes exist", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ memories: sampleMemories, persona: samplePersona }),
      );

      expect(result.appendSystemContext).toBeDefined();
      expect(result.appendSystemContext!).toContain("## Memory Tools");
      expect(result.appendSystemContext!).toContain("tdai_memory_search");
      expect(result.appendSystemContext!).toContain("tdai_conversation_search");
      expect(result.appendSystemContext!).toContain("tdai_read_scene");
    });

    it("should include rate limit guidance when system context exists", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({ memories: sampleMemories, persona: samplePersona }),
      );

      expect(result.appendSystemContext).toContain("max 3");
    });

    it("should return empty/undefined when no data", () => {
      const result = adapter.formatRecallResult(makeRecallResult());

      expect(result.prependContext).toBeFalsy();
      expect(result.appendSystemContext).toBeFalsy();
    });

    it("should handle memory without score", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({
          memories: [{ type: "episodic", content: "No score" }],
        }),
      );

      expect(result.prependContext).toContain("No score");
      expect(result.prependContext).not.toContain("score:");
    });

    it("should combine persona + scenes + tools in appendSystemContext", () => {
      const result = adapter.formatRecallResult(
        makeRecallResult({
          memories: sampleMemories,
          persona: samplePersona,
          scenes: sampleScenes,
        }),
      );

      expect(result.appendSystemContext).toContain("## User Persona");
      expect(result.appendSystemContext).toContain("## Scene Navigation");
      expect(result.appendSystemContext).toContain("## Memory Tools");
      // Order: persona → scenes → tools
      const personaIdx = result.appendSystemContext!.indexOf("## User Persona");
      const sceneIdx = result.appendSystemContext!.indexOf("## Scene Navigation");
      const toolsIdx = result.appendSystemContext!.indexOf("## Memory Tools");
      expect(personaIdx).toBeLessThan(sceneIdx);
      expect(sceneIdx).toBeLessThan(toolsIdx);
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
      expect(convTool!.parameters.properties).toHaveProperty("session_key");
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
      }
    });
  });

  // ── formatToolResult ────────────────────────────────────────────

  describe("formatToolResult", () => {
    it("should format memory search results as Markdown", () => {
      const searchResult: SearchResult = {
        text: "",
        total: 2,
        items: sampleMemories.slice(0, 2),
      };

      const formatted = adapter.formatToolResult("tdai_memory_search", searchResult);
      expect(formatted).toContain("[persona]");
      expect(formatted).toContain("Prefers dark mode");
    });

    it("should return 'No results' for empty L1 search", () => {
      const searchResult: SearchResult = {
        text: "",
        total: 0,
        items: [],
      };

      const formatted = adapter.formatToolResult("tdai_memory_search", searchResult);
      expect(formatted).toContain("No results");
    });

    it("should return 'No results' for empty L0 search", () => {
      const searchResult: SearchResult = {
        text: "",
        total: 0,
        items: [],
      };

      const formatted = adapter.formatToolResult("tdai_conversation_search", searchResult);
      expect(formatted).toContain("No results");
    });

    it("should pass through string results (scene content)", () => {
      const sceneContent = "# Travel Plan\n\nDestination: Japan";
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

    it("should normalize content block arrays", () => {
      const messages = adapter.normalizeMessages([
        {
          role: "user",
          content: [{ type: "text", text: "Hello from blocks" }],
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello from blocks");
    });

    it("should handle input_text type blocks", () => {
      const messages = adapter.normalizeMessages([
        {
          role: "user",
          content: [{ type: "input_text", text: "Input text content" }],
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("Input text content");
    });

    it("should skip messages with null content", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: null },
        { role: "assistant", content: "Valid" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Valid");
    });

    it("should skip messages with undefined content", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: undefined },
        { role: "assistant", content: "Valid" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Valid");
    });

    it("should map role aliases correctly", () => {
      const messages = adapter.normalizeMessages([
        { role: "human", content: "Hello" },
        { role: "ai", content: "Hi" },
        { role: "developer", content: "System msg" },
        { role: "function", content: "Tool result" },
      ]);

      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[2].role).toBe("system");
      expect(messages[3].role).toBe("tool");
    });

    it("should skip messages with unknown roles", () => {
      const messages = adapter.normalizeMessages([
        { role: "moderator", content: "Unknown role" },
        { role: "user", content: "Valid" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
    });

    it("should skip non-object entries in array", () => {
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

    it("should not add timestamp when not provided", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: "Hello" },
      ]);

      // Codex adapter does not auto-generate timestamps
      expect(messages[0].timestamp).toBeUndefined();
    });

    it("should preserve provided timestamps", () => {
      const messages = adapter.normalizeMessages([
        { role: "user", content: "Hello", timestamp: "2024-06-15T12:00:00Z" },
      ]);

      expect(messages[0].timestamp).toBe("2024-06-15T12:00:00Z");
    });

    it("should concatenate multiple text blocks", () => {
      const messages = adapter.normalizeMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("First part");
      expect(messages[0].content).toContain("Second part");
    });
  });
});
