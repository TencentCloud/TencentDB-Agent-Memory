/**
 * session-key resolution tests (issue #1179 — dsh via pi-ai sends no session
 * headers at all, which silently skipped session-init + injection).
 */
import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  resolveConversationId,
  resolveDshFallbackConversationId,
} from "../session-key.js";

/** Minimal Hono Context stub — resolveConversationId only uses req.header. */
function fakeContext(headers: Record<string, string>): Context {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Context;
}

describe("resolveDshFallbackConversationId (#1179)", () => {
  it("returns the stable sessionKey for dsh", () => {
    expect(resolveDshFallbackConversationId("dsh", "a5a6b272")).toBe("a5a6b272");
  });

  it("returns null for an empty sessionKey", () => {
    expect(resolveDshFallbackConversationId("dsh", "")).toBeNull();
  });

  it("returns null for other agent sources (behavior unchanged)", () => {
    expect(resolveDshFallbackConversationId("codebuddy", "abc")).toBeNull();
    expect(resolveDshFallbackConversationId("claude-code", "abc")).toBeNull();
    expect(resolveDshFallbackConversationId("workbuddy", "abc")).toBeNull();
    expect(resolveDshFallbackConversationId("codex", "abc")).toBeNull();
  });
});

describe("resolveConversationId", () => {
  it("prefers x-conversation-id", () => {
    const c = fakeContext({ "x-conversation-id": "conv-1", "x-session-affinity": "aff-1" });
    expect(resolveConversationId(c)).toBe("conv-1");
  });

  it("prefers x-deepseek-harness-session-id over x-session-affinity", () => {
    const c = fakeContext({
      "x-deepseek-harness-session-id": "session-abc",
      "x-session-affinity": "aff-1",
    });
    expect(resolveConversationId(c)).toBe("session-abc");
  });

  it("falls back to x-session-affinity (pi-ai sendSessionAffinityHeaders, openai format)", () => {
    const c = fakeContext({ "x-session-affinity": "session-abc", "x-stainless-arch": "x64" });
    expect(resolveConversationId(c)).toBe("session-abc");
  });

  it("returns null when no session header is present (pi-ai default traffic)", () => {
    const c = fakeContext({ "x-stainless-arch": "x64", "x-stainless-lang": "js" });
    expect(resolveConversationId(c)).toBeNull();
  });
});
