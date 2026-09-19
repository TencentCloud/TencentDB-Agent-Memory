/**
 * session-key resolution tests (issue #1179 — dsh via pi-ai sends no session
 * headers at all, which silently skipped session-init + injection).
 */
import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  deriveConversationIdFromMessages,
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

describe("resolveDshFallbackConversationId (#1179 + review P1: per-conversation isolation)", () => {
  /** 同一 user key（keyId="key-user"）下的两个**不同** dsh 会话，无会话头。 */
  const convA = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "帮我修一下登录 bug" },
  ];
  const convB = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Write a haiku about the ocean" },
  ];

  it("derives DIFFERENT session ids for two same-key conversations (P1 regression)", () => {
    const idA = resolveDshFallbackConversationId("dsh", convA);
    const idB = resolveDshFallbackConversationId("dsh", convB);
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(idA).not.toBe(idB);
  });

  it("keeps memory grouping (composite store key) separate for the two conversations", () => {
    // handler.ts 里 session-init 状态 / L0 写入 / 绑定全部按 `${agentSource}:${sessionKey}`
    // 分组（sessionKey = conversationId 兜底值）——两个不同会话的分组键不得相同。
    const idA = resolveDshFallbackConversationId("dsh", convA)!;
    const idB = resolveDshFallbackConversationId("dsh", convB)!;
    const groupA = `dsh:${idA}`;
    const groupB = `dsh:${idB}`;
    expect(groupA).not.toBe(groupB);
    expect(groupA).not.toBe("dsh:key-user"); // 不再落回共享的 keyId 会话
    expect(groupB).not.toBe("dsh:key-user");
  });

  it("is STABLE across turns of the same conversation (history grows, anchor unchanged)", () => {
    // 同一会话的第二轮：历史追加 assistant / 后续 user（system-reminder 等），
    // 首条 user 消息不变 → 派生标识必须与首轮一致，session-init 状态才能连续。
    const turn2 = [
      ...convA,
      { role: "assistant", content: "好的，我来看看。" },
      { role: "tool", content: "ls: src/login.ts", tool_call_id: "call_1" },
      { role: "user", content: "<system-reminder>工作区指令</system-reminder>" },
    ];
    expect(resolveDshFallbackConversationId("dsh", turn2)).toBe(
      resolveDshFallbackConversationId("dsh", convA),
    );
  });

  it("returns a deterministic dsh-der-* id", () => {
    const id = resolveDshFallbackConversationId("dsh", convA);
    expect(id).toMatch(/^dsh-der-[0-9a-f]{16}$/);
    expect(deriveConversationIdFromMessages(convA)).toBe(id);
  });

  it("returns null when the body has no user message (fail-closed signal)", () => {
    expect(resolveDshFallbackConversationId("dsh", [])).toBeNull();
    expect(resolveDshFallbackConversationId("dsh", [{ role: "system", content: "x" }])).toBeNull();
    expect(resolveDshFallbackConversationId("dsh", undefined)).toBeNull();
    expect(resolveDshFallbackConversationId("dsh", null)).toBeNull();
    expect(resolveDshFallbackConversationId("dsh", [{ role: "user", content: "" }])).toBeNull();
  });

  it("supports openai parts content arrays", () => {
    const parts = resolveDshFallbackConversationId("dsh", [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: "x" }] },
    ]);
    expect(parts).toBe(deriveConversationIdFromMessages([{ role: "user", content: "hi" }]));
  });

  it("returns null for other agent sources (behavior unchanged)", () => {
    const msgs = [{ role: "user", content: "hello" }];
    expect(resolveDshFallbackConversationId("codebuddy", msgs)).toBeNull();
    expect(resolveDshFallbackConversationId("claude-code", msgs)).toBeNull();
    expect(resolveDshFallbackConversationId("workbuddy", msgs)).toBeNull();
    expect(resolveDshFallbackConversationId("codex", msgs)).toBeNull();
  });
});

describe("end-to-end conversation resolution (#1179 + P1)", () => {
  it("header always wins over body derivation", () => {
    const c = fakeContext({ "x-session-affinity": "session-abc" });
    const headerId = resolveConversationId(c);
    const fallbackId = resolveDshFallbackConversationId("dsh", [
      { role: "user", content: "你好" },
    ]);
    // handler.ts: conversationId = header ?? dsh fallback
    expect(headerId ? headerId : fallbackId).toBe("session-abc");
    expect(fallbackId).not.toBeNull();
    expect(fallbackId).not.toBe("session-abc");
  });

  it("headerless dsh resolves to the derived per-conversation id (not keyId)", () => {
    const c = fakeContext({ "x-stainless-arch": "x64" }); // pi-ai 默认流量：无会话头
    const headerId = resolveConversationId(c);
    expect(headerId).toBeNull();
    const fallbackId = resolveDshFallbackConversationId("dsh", [
      { role: "user", content: "你好" },
    ]);
    expect(fallbackId).toMatch(/^dsh-der-/);
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
