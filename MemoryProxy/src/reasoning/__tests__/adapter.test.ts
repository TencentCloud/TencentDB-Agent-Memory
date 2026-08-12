/**
 * 946-A Reasoning Protocol Adapter — tests.
 *
 * 覆盖（docs/946spec.md §22.5）：
 *   - capability 解析按 provider+model（不按客户端应用）
 *   - DeepSeek reasoning 模型允许补空 reasoning_content（preserve-or-empty）
 *   - 其它 provider 缺失即报错（fail-closed）
 *   - isPreservableProviderSignature 语义（不解释签名有效性）
 *   - OpenAI forward 规范化：缺失+允许 → 补空；缺失+禁止 → blocked
 *   - Anthropic forward 规范化：adaptive→enabled、tool_use 补 thinking 块、非 anthropic 不处理
 */

import { describe, it, expect } from "vitest";
import {
  resolveUpstreamCapabilities,
  resolveMissingReasoningPolicy,
  isPreservableProviderSignature,
  OpenAIReasoningAdapter,
  MISSING_REASONING_CONTEXT,
  type CanonicalAssistantMessage,
} from "../adapter.js";
import { normalizeOpenAiForward } from "../openai-forward.js";
import { normalizeAnthropicForward, requiresAnthropicThinkingRoundTrip } from "../anthropic-forward.js";

describe("resolveUpstreamCapabilities (capability-driven, not client-driven)", () => {
  it("resolves DeepSeek reasoning model with manual-budget + roundtrip", () => {
    const caps = resolveUpstreamCapabilities("deepseek", "deepseek-reasoner");
    expect(caps).not.toBeNull();
    expect(caps?.dialect).toBe("openai");
    expect(caps?.supportsAdaptiveThinking).toBe(false);
    expect(caps?.requiresReasoningRoundTripForToolCalls).toBe(true);
  });

  it("resolves Anthropic with adaptive + signature support", () => {
    const caps = resolveUpstreamCapabilities("anthropic", "claude-sonnet-4-5");
    expect(caps?.dialect).toBe("anthropic");
    expect(caps?.supportsAdaptiveThinking).toBe(true);
    expect(caps?.supportsThinkingSignature).toBe(true);
  });

  it("returns null for unknown provider (fail-closed)", () => {
    expect(resolveUpstreamCapabilities("unknown-provider", "x")).toBeNull();
  });

  it("is case-insensitive on provider", () => {
    expect(resolveUpstreamCapabilities("DeepSeek", "deepseek-reasoner")?.dialect).toBe("openai");
  });
});

describe("resolveMissingReasoningPolicy (§16)", () => {
  it("allows preserve-or-empty for DeepSeek reasoning models", () => {
    expect(resolveMissingReasoningPolicy("deepseek", "deepseek-reasoner")).toBe("preserve-or-empty");
    expect(resolveMissingReasoningPolicy("deepseek", "DeepSeek-R1")).toBe("preserve-or-empty");
  });

  it("allows preserve-or-empty for DeepSeek V4 family (default thinking, e.g. deepseek-v4-flash)", () => {
    expect(resolveMissingReasoningPolicy("deepseek", "deepseek-v4-flash")).toBe("preserve-or-empty");
    expect(resolveMissingReasoningPolicy("deepseek", "deepseek-v4")).toBe("preserve-or-empty");
    expect(resolveMissingReasoningPolicy("deepseek", "deepseek-v4-0324")).toBe("preserve-or-empty");
  });

  it("errors for non-reasoning DeepSeek models", () => {
    expect(resolveMissingReasoningPolicy("deepseek", "deepseek-chat")).toBe("error");
  });

  it("errors for non-DeepSeek providers (no silent injection)", () => {
    expect(resolveMissingReasoningPolicy("openai", "gpt-4o")).toBe("error");
    expect(resolveMissingReasoningPolicy("anthropic", "claude-3-5-sonnet")).toBe("error");
  });
});

describe("isPreservableProviderSignature (§17)", () => {
  it("accepts UUID-format signature", () => {
    expect(isPreservableProviderSignature({ signature: "550e8400-e29b-41d4-a716-446655440000" })).toBe(true);
  });

  it("accepts long base64-style signature", () => {
    expect(isPreservableProviderSignature({ signature: "A".repeat(48) })).toBe(true);
  });

  it("rejects short signature", () => {
    expect(isPreservableProviderSignature({ signature: "short" })).toBe(false);
  });

  it("rejects missing/empty signature", () => {
    expect(isPreservableProviderSignature({})).toBe(false);
    expect(isPreservableProviderSignature({ signature: "" })).toBe(false);
  });

  it("rejects signatures with non-base64 chars (unpreservable)", () => {
    expect(isPreservableProviderSignature({ signature: "!!!not-base64!!!".padEnd(40, "x") })).toBe(false);
  });
});

describe("OpenAIReasoningAdapter", () => {
  const toolAssistant: CanonicalAssistantMessage = {
    role: "assistant",
    toolCalls: [{ id: "call_1", name: "tool", arguments: "{}" }],
  };

  it("throws MISSING_REASONING_CONTEXT when roundtrip required but not allowed", () => {
    const adapter = new OpenAIReasoningAdapter({ allowEmptyReasoningBackfill: false });
    expect(() =>
      adapter.normalizeRequest([toolAssistant], {
        dialect: "openai",
        supportsAdaptiveThinking: false,
        supportsManualThinkingBudget: true,
        requiresReasoningRoundTripForToolCalls: true,
        supportsThinkingSignature: false,
      }),
    ).toThrow(MISSING_REASONING_CONTEXT);
  });

  it("backfills empty reasoning when allowed", () => {
    const adapter = new OpenAIReasoningAdapter({ allowEmptyReasoningBackfill: true });
    const out = adapter.normalizeRequest([toolAssistant], {
      dialect: "openai",
      supportsAdaptiveThinking: false,
      supportsManualThinkingBudget: true,
      requiresReasoningRoundTripForToolCalls: true,
      supportsThinkingSignature: false,
    }) as CanonicalAssistantMessage[];
    expect(out[0].providerState?.reasoningContent).toBe("");
  });

  it("does nothing when roundtrip not required", () => {
    const adapter = new OpenAIReasoningAdapter();
    const out = adapter.normalizeRequest([toolAssistant], {
      dialect: "openai",
      supportsAdaptiveThinking: false,
      supportsManualThinkingBudget: true,
      requiresReasoningRoundTripForToolCalls: false,
      supportsThinkingSignature: false,
    }) as CanonicalAssistantMessage[];
    expect(out[0].providerState?.reasoningContent).toBeUndefined();
  });
});

describe("normalizeOpenAiForward", () => {
  const bodyWithToolHistory = (reasoning?: string) => ({
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      },
    ],
  });

  it("backfills empty reasoning_content for DeepSeek reasoning model", () => {
    const out = normalizeOpenAiForward(bodyWithToolHistory(), "deepseek", "deepseek-reasoner");
    expect(out.changed).toBe(true);
    expect(out.blocked).toBe(false);
    const msgs = out.body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].reasoning_content).toBe("");
  });

  it("backfills empty reasoning_content for DeepSeek V4 flash (thinking-mode default)", () => {
    const out = normalizeOpenAiForward(bodyWithToolHistory(), "deepseek", "deepseek-v4-flash");
    expect(out.changed).toBe(true);
    expect(out.blocked).toBe(false);
    const msgs = out.body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].reasoning_content).toBe("");
  });

  it("preserves existing reasoning_content (no change)", () => {
    const out = normalizeOpenAiForward(bodyWithToolHistory("thinking text"), "deepseek", "deepseek-reasoner");
    expect(out.changed).toBe(false);
  });

  it("passes through unchanged for non-DeepSeek provider (never blocks/injects)", () => {
    const out = normalizeOpenAiForward(bodyWithToolHistory(), "openai", "gpt-4o");
    expect(out.changed).toBe(false);
    expect(out.blocked).toBe(false);
    // 原始 body 不被改动（reasoning_content 不注入）
    const msgs = out.body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].reasoning_content).toBeUndefined();
  });

  it("passes through unchanged for DeepSeek non-reasoning model", () => {
    const out = normalizeOpenAiForward(bodyWithToolHistory(), "deepseek", "deepseek-chat");
    expect(out.changed).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it("is a no-op when no assistant tool_calls in history", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const out = normalizeOpenAiForward(body, "deepseek", "deepseek-reasoner");
    expect(out.changed).toBe(false);
    expect(out.blocked).toBe(false);
  });
});

describe("normalizeAnthropicForward", () => {
  const bodyWithToolUse = () => ({
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "f", input: {} }],
      },
    ],
  });

  it("downgrades adaptive→enabled + backfills tool_use thinking when upstream does NOT support adaptive (DeepSeek compat)", () => {
    const out = normalizeAnthropicForward(bodyWithToolUse(), "anthropic", false);
    expect(out.changed).toBe(true);
    expect((out.body.thinking as Record<string, unknown>).type).toBe("enabled");
    expect((out.body.thinking as Record<string, unknown>).budget_tokens).toBe(16000);
    const content = (out.body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("thinking");
    expect(content[0].thinking).toBe("");
  });

  it("preserves adaptive when upstream supports it (real Claude), still backfills tool_use thinking", () => {
    const out = normalizeAnthropicForward(bodyWithToolUse(), "anthropic", true);
    expect(out.changed).toBe(true);
    // 真 Claude 原生支持 adaptive → 不降级
    expect((out.body.thinking as Record<string, unknown>).type).toBe("adaptive");
    const content = (out.body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("thinking");
    expect(content[0].thinking).toBe("");
  });

  it("does not touch non-anthropic providers", () => {
    const out = normalizeAnthropicForward(bodyWithToolUse(), "deepseek", true);
    expect(out.changed).toBe(false);
  });

  it("does not duplicate thinking block when already present", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "t1", name: "f", input: {} }],
        },
      ],
    };
    const out = normalizeAnthropicForward(body, "anthropic", true);
    expect(out.changed).toBe(false);
  });

  it("requiresAnthropicThinkingRoundTrip is provider-scoped", () => {
    expect(requiresAnthropicThinkingRoundTrip("anthropic")).toBe(true);
    expect(requiresAnthropicThinkingRoundTrip("Anthropic")).toBe(true);
    expect(requiresAnthropicThinkingRoundTrip("deepseek")).toBe(false);
  });

  it("does NOT backfill thinking block when thinking mode is off (no thinking field)", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "f", input: {} }],
        },
      ],
    };
    const out = normalizeAnthropicForward(body, "anthropic", false);
    expect(out.changed).toBe(false);
  });
});
