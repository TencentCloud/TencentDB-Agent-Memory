/**
 * Hermes agent adapter 单测（#1196 TRACK 03 模式）。
 */
import { describe, expect, it } from "vitest";
import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { hermesAdapter } from "../agent-adapters/hermes.js";

describe("hermes adapter", () => {
  it("resolves by agentSource", () => {
    expect(resolveAgentAdapter("hermes").agentKind).toBe("hermes");
  });

  it("classifies every request as main (no aux fingerprint yet)", () => {
    expect(hermesAdapter.classifyRequest({}, "/hermes/default/v1/chat/completions", { "user-agent": "hermes-cli/0.19.0" })).toBe("main");
  });

  it("extracts plain-string user text (OpenAI SDK default form)", () => {
    expect(hermesAdapter.extractUserText("帮我查一下")).toBe("帮我查一下");
    expect(hermesAdapter.extractUserText("")).toBeNull();
  });

  it("falls back to default adapter for non-string content", () => {
    expect(hermesAdapter.extractUserText([{ type: "text", text: "hello" }])).toBe("hello");
    expect(hermesAdapter.extractUserText([{ type: "tool_result", content: "x" }])).toBeNull();
    expect(hermesAdapter.extractUserText(null)).toBeNull();
  });
});
