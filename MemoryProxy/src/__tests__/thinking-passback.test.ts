import { describe, expect, it } from "vitest";
import {
  ensureToolCallThinkingPassback,
  prepareAnthropicUpstreamBody,
  requiresThinkingPassback,
  sanitizeThinkingBlocks,
} from "../anthropicHandler.js";

const VALID_ANTHROPIC_SIGNATURE = "A".repeat(48);

function assistantWithToolUse(content: unknown[]) {
  return {
    role: "assistant",
    content,
  };
}

describe("requiresThinkingPassback", () => {
  it("is true for DeepSeek Anthropic-compat upstreams", () => {
    expect(
      requiresThinkingPassback(
        { url: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash" },
        { model: "deepseek-v4-flash" },
      ),
    ).toBe(true);
  });

  it("is true when only the model id is DeepSeek", () => {
    expect(
      requiresThinkingPassback(
        { url: "https://gateway.example.com/anthropic", model: "deepseek-v4-pro" },
        {},
      ),
    ).toBe(true);
  });

  it("is false for native Anthropic", () => {
    expect(
      requiresThinkingPassback(
        { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-5" },
        { model: "claude-sonnet-4-5" },
      ),
    ).toBe(false);
  });
});

describe("sanitizeThinkingBlocks", () => {
  it("still strips unsigned thinking for native Anthropic history", () => {
    const body = {
      messages: [
        assistantWithToolUse([
          { type: "thinking", thinking: "plan", signature: "" },
          { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: {} },
        ]),
      ],
    };
    const { body: out, removed } = sanitizeThinkingBlocks(body);
    expect(removed).toBe(1);
    expect((out.messages as Array<{ content: Array<{ type: string }> }>)[0].content.map((b) => b.type)).toEqual([
      "tool_use",
    ]);
  });

  it("keeps thinking blocks with a valid Anthropic signature", () => {
    const body = {
      messages: [
        assistantWithToolUse([
          { type: "thinking", thinking: "plan", signature: VALID_ANTHROPIC_SIGNATURE },
          { type: "text", text: "hi" },
        ]),
      ],
    };
    const { body: out, removed } = sanitizeThinkingBlocks(body);
    expect(removed).toBe(0);
    expect(out).toBe(body);
  });
});

describe("ensureToolCallThinkingPassback", () => {
  it("injects a non-empty thinking block before tool_use when missing", () => {
    const original = {
      messages: [
        { role: "user", content: "hello" },
        assistantWithToolUse([
          { type: "tool_use", id: "toolu_cc_session_init_1", name: "AskUserQuestion", input: {} },
        ]),
        { role: "user", content: "是，关联团队资产" },
      ],
    };
    const snapshot = structuredClone(original);
    const { body: out, injected } = ensureToolCallThinkingPassback(original);

    expect(injected).toBe(1);
    expect(original).toEqual(snapshot);

    const assistant = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[1];
    expect(assistant.content[0]?.type).toBe("thinking");
    expect(String(assistant.content[0]?.thinking).length).toBeGreaterThan(0);
    expect(assistant.content[1]?.type).toBe("tool_use");
  });

  it("does not replace an existing thinking block", () => {
    const { body: out, injected } = ensureToolCallThinkingPassback({
      messages: [
        assistantWithToolUse([
          { type: "thinking", thinking: "original plan", signature: "" },
          { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: {} },
        ]),
      ],
    });
    expect(injected).toBe(0);
    const assistant = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
    expect(assistant.content[0]?.thinking).toBe("original plan");
  });
});

describe("prepareAnthropicUpstreamBody issue #990", () => {
  it("keeps unsigned thinking + tool_use when forwarding to DeepSeek", () => {
    const body = {
      model: "deepseek-v4-flash",
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "hello" },
        assistantWithToolUse([
          { type: "thinking", thinking: "session-init", signature: "" },
          { type: "tool_use", id: "toolu_cc_session_init_1", name: "AskUserQuestion", input: {} },
        ]),
        { role: "user", content: "是，关联团队资产" },
      ],
    };

    const { body: out } = prepareAnthropicUpstreamBody(body, {
      url: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
      bodyOverrides: null,
    });

    const assistant = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[1];
    const types = assistant.content.map((b) => b.type);
    expect(types).toContain("thinking");
    expect(types).toContain("tool_use");
    expect(assistant.content.find((b) => b.type === "thinking")?.thinking).toBe("session-init");
  });

  it("injects thinking when Claude Code session-init history has tool_use only", () => {
    const body = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hello" },
        assistantWithToolUse([
          { type: "tool_use", id: "toolu_cc_session_init_1", name: "AskUserQuestion", input: {} },
        ]),
        { role: "user", content: "是，关联团队资产" },
      ],
    };

    const { body: out } = prepareAnthropicUpstreamBody(body, {
      url: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
      bodyOverrides: null,
    });

    const assistant = (out.messages as Array<{ content: Array<Record<string, unknown>> }>)[1];
    expect(assistant.content[0]?.type).toBe("thinking");
    expect(String(assistant.content[0]?.thinking).length).toBeGreaterThan(0);
    expect(assistant.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("still strips unsigned thinking when forwarding to native Anthropic", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [
        assistantWithToolUse([
          { type: "thinking", thinking: "plan", signature: "" },
          { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: {} },
        ]),
      ],
    };

    const { body: out, sanitizedCount } = prepareAnthropicUpstreamBody(body, {
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-sonnet-4-5",
      bodyOverrides: null,
    });

    expect(sanitizedCount).toBe(1);
    const assistant = (out.messages as Array<{ content: Array<{ type: string }> }>)[0];
    expect(assistant.content.map((b) => b.type)).toEqual(["tool_use"]);
  });
});
