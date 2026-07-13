import { describe, expect, it } from "vitest";
import {
  captureInputSchema,
  conversationSearchInputSchema,
  memorySearchInputSchema,
  normalizeLimit,
  recallInputSchema,
  sessionEndInputSchema,
} from "./tool-schemas.js";

describe("Kimi Code MCP tool schemas", () => {
  it("requires recall query and session_key", () => {
    expect(recallInputSchema.parse({
      query: "what does the user prefer",
      session_key: "session-1",
    })).toEqual({
      query: "what does the user prefer",
      session_key: "session-1",
    });

    expect(() => recallInputSchema.parse({ query: "", session_key: "session-1" })).toThrow();
    expect(() => recallInputSchema.parse({ query: "hello", session_key: "" })).toThrow();
  });

  it("requires capture user and assistant content", () => {
    const parsed = captureInputSchema.parse({
      user_content: "remember this",
      assistant_content: "stored",
      session_key: "session-1",
    });

    expect(parsed.user_content).toBe("remember this");
    expect(parsed.assistant_content).toBe("stored");
    expect(parsed.session_key).toBe("session-1");
  });

  it("clamps tool search limits to Gateway-supported bounds", () => {
    expect(normalizeLimit(undefined)).toBe(5);
    expect(normalizeLimit(0)).toBe(1);
    expect(normalizeLimit(99)).toBe(20);
    expect(normalizeLimit(7)).toBe(7);
  });

  it("accepts memory search filters", () => {
    const parsed = memorySearchInputSchema.parse({
      query: "coding preference",
      limit: 6,
      type: "persona",
      scene: "repo-maintenance",
    });

    expect(parsed).toEqual({
      query: "coding preference",
      limit: 6,
      type: "persona",
      scene: "repo-maintenance",
    });
  });

  it("accepts conversation search and session end inputs", () => {
    expect(conversationSearchInputSchema.parse({
      query: "previous test command",
      session_key: "session-1",
    })).toEqual({
      query: "previous test command",
      session_key: "session-1",
    });

    expect(sessionEndInputSchema.parse({ session_key: "session-1" })).toEqual({
      session_key: "session-1",
    });
  });
});
