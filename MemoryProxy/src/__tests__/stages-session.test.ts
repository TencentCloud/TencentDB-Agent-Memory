/**
 * 会话阶段（纯计算）用例：与 handler 原逻辑对齐。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sessionStage } from "../stages/session.js";
import type { ReqCtx } from "../stages/types.js";
import type { SessionAdapter } from "../stages/types.js";
import {
  __resetAutoSessionForTests,
  __setAutoSessionNow,
} from "../session/auto-session.js";
import { apiKeyToKeyId } from "../opik.js";
import { firstUserMessageFingerprint } from "../session/session-key.js";

function makeCtx(over: Partial<ReqCtx> = {}): ReqCtx {
  return {
    c: {
      req: {
        raw: { headers: new Headers({ "x-api-key": "sk-test", authorization: "Bearer sk-test" }) },
        header: (n: string) => (n === "x-api-key" ? "sk-test" : null),
        path: "/claude-code/default/v1/messages",
      },
    } as never,
    config: {
      sessionInit: { autoConversationId: { enabled: true, ttlMinutes: 30, strategy: "per-key" } },
    } as never,
    body: { messages: [{ role: "user", content: "hi" }], model: "m" },
    agentSource: "claude-code",
    apiKey: "sk-test",
    earlySpaceId: "default",
    earlyUserId: "",
    ...over,
  } as ReqCtx;
}

describe("sessionStage", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    __setAutoSessionNow(() => Date.now());
  });

  it("自动生成会话键并产出身份字段", async () => {
    const ctx = makeCtx();
    await sessionStage(ctx);
    expect(ctx.sessionKey).toMatch(/^auto-[0-9a-f]{16}-/);
    expect(ctx.keyId).toBe(apiKeyToKeyId("sk-test"));
    expect(ctx.userId).toBe("");
    expect(ctx.spaceId).toBe("default");
    expect(ctx.callerUserKey).toBe("sk-test");
    expect(ctx.lcHeaders).toBeDefined();
  });

  it("earlyUserId 存在时 keyId 改用 userId（与 handler 原逻辑一致）", async () => {
    const ctx = makeCtx({ earlyUserId: "u1" });
    await sessionStage(ctx);
    expect(ctx.keyId).toBe("u1");
    expect(ctx.userId).toBe("u1");
  });

  it("显式 x-conversation-id 优先于自动生成", async () => {
    const ctx = makeCtx();
    ctx.c = {
      req: {
        raw: { headers: new Headers({ "x-conversation-id": "explicit-1", "x-api-key": "sk-test" }) },
        header: (n: string) =>
          n === "x-conversation-id" ? "explicit-1" : n === "x-api-key" ? "sk-test" : null,
        path: "/claude-code/default/v1/messages",
      },
    } as never;
    await sessionStage(ctx);
    expect(ctx.sessionKey).toBe("explicit-1");
  });

  it("自定义适配器：codex 风格（body.input + client_metadata + traceId 兜底）", async () => {
    const adapter: SessionAdapter = {
      extractRawSessionId(_c, _h, body) {
        const meta = (body.client_metadata as { session_id?: string } | undefined);
        return meta?.session_id ?? null;
      },
      userMessages(body) {
        return body.input;
      },
      fallbackSessionKey(ctx, keyId) {
        return `${keyId}:${ctx.traceId}`;
      },
      resolveThreadId() {
        return null;
      },
      // codex 风格：不改写 keyId、不填 userId
      resolveIdentity(_ctx, keyId) {
        return { keyId, userId: "", callerUserKey: null };
      },
    };
    const ctx = makeCtx({
      body: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        client_metadata: { session_id: "meta-session-1" },
      },
      traceId: "trace-1",
    });
    await sessionStage(ctx, adapter);
    expect(ctx.sessionKey).toBe("meta-session-1");
    expect(ctx.keyId).toBe(apiKeyToKeyId("sk-test")); // 直通，不被 userId 改写
    expect(ctx.userId).toBe("");

    // 无显式会话 ID → 自动生成 + traceId 兜底
    const ctx2 = makeCtx({
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      traceId: "trace-2",
    });
    await sessionStage(ctx2, adapter);
    expect(ctx2.sessionKey).toMatch(/^auto-[0-9a-f]{16}-/);
  });

  it("无显式会话 + 不自动生成：首问指纹兜底键跨请求稳定（对齐 CC 的稳定 keyId 语义）", async () => {
    const adapter: SessionAdapter = {
      extractRawSessionId() {
        return null;
      },
      userMessages(body) {
        return body.input;
      },
      fallbackSessionKey(ctx, keyId) {
        // 镜像 codex/workbuddy 新兜底：首问指纹稳定键；无指纹回退 ephemeral
        const fp = firstUserMessageFingerprint(ctx.body.input);
        return fp ? `${keyId}:msg-${fp}` : `${keyId}:ephemeral`;
      },
      resolveThreadId() {
        return null;
      },
      resolveIdentity(_ctx, keyId) {
        return { keyId, userId: "", callerUserKey: null };
      },
      autoGenerate: false,
    };
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] }],
      model: "m",
    };
    const a = makeCtx({ body, traceId: "t1" });
    const b = makeCtx({ body, traceId: "t2" });
    await sessionStage(a, adapter);
    await sessionStage(b, adapter);
    // 同一会话内容 → 兜底键一致（不再逐请求 traceId 碎片化）
    expect(a.sessionKey).toBe(b.sessionKey);
  });
});
describe("autoGenerate:false 的 raw auto-* 也要过签名校验", () => {
  it("workbuddy 风格适配器收到伪造 auto ID → 回退兜底键，不把 raw 当会话键", async () => {
    const adapter: SessionAdapter = {
      extractRawSessionId: () => "auto-0011223344556677-00000000-0000-4000-8000-000000000000",
      userMessages: (b) => b.messages,
      fallbackSessionKey: () => "fb",
      resolveThreadId: () => null,
      resolveIdentity: (_ctx, keyId) => ({ keyId, userId: "", callerUserKey: null }),
      autoGenerate: false,
    };
    const ctx = makeCtx();
    await sessionStage(ctx, adapter);
    expect(ctx.conversationId).toBeNull();
    expect(ctx.sessionKey).toBe("fb");
  });
});
