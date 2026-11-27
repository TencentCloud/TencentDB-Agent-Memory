import { describe, it, expect } from "vitest";
import { piAdapter } from "../pi.js";
import { resolveAgentAdapter } from "../index.js";

describe("piAdapter", () => {
  it("declares agentKind 'pi'", () => {
    expect(piAdapter.agentKind).toBe("pi");
  });

  it("classifies every request as 'main' (Pi has no fork/sidequery)", () => {
    expect(piAdapter.classifyRequest({ messages: [] })).toBe("main");
    expect(piAdapter.classifyRequest({ tools: [{ type: "function" }] })).toBe("main");
    expect(piAdapter.classifyRequest({})).toBe("main");
  });

  it("extracts user text from a plain string (Pi's usual shape)", () => {
    expect(piAdapter.extractUserText("Reply with exactly: PONG")).toBe("Reply with exactly: PONG");
    expect(piAdapter.extractUserText("")).toBeNull();
  });

  it("delegates array content to defaultAdapter (join text blocks)", () => {
    const content = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ];
    expect(piAdapter.extractUserText(content)).toBe("line one\nline two");
  });

  it("returns null for non-string non-array content", () => {
    expect(piAdapter.extractUserText(null)).toBeNull();
    expect(piAdapter.extractUserText(undefined)).toBeNull();
    expect(piAdapter.extractUserText(42)).toBeNull();
  });
});

describe("resolveAgentAdapter('pi')", () => {
  it("returns piAdapter", () => {
    expect(resolveAgentAdapter("pi")).toBe(piAdapter);
  });
});
