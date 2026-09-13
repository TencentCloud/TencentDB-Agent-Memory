import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  prepareSessionTurn,
  type SessionTurnResult,
} from "../stages/session-turn.js";
import {
  DEFAULT_SESSION_ADAPTER,
  RESPONSES_SESSION_ADAPTER,
  WORKBUDDY_SESSION_ADAPTER,
} from "../stages/session.js";
import type { ReqCtx } from "../stages/types.js";
import {
  __resetAutoSessionForTests,
  __setAutoSessionNow,
} from "../session/auto-session.js";

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
      sessionInit: {
        autoConversationId: { enabled: true, ttlMinutes: 30, strategy: "per-key" },
        threadIsolation: { enabled: true },
      },
    } as never,
    body: { messages: [{ role: "user", content: "hi" }], model: "m" },
    agentSource: "claude-code",
    apiKey: "sk-test",
    earlySpaceId: "default",
    earlyUserId: "",
    ...over,
  } as ReqCtx;
}

function withThread(
  base: ReqCtx,
  threadId: string,
  headers: Record<string, string> = {},
): ReqCtx {
  base.c = {
    req: {
      raw: {
        headers: new Headers({
          "x-thread-id": threadId,
          "x-api-key": "sk-test",
          ...headers,
        }),
      },
      header: (n: string) =>
        n === "x-thread-id"
          ? threadId
          : n === "x-api-key"
            ? "sk-test"
            : headers[n.toLowerCase()] ?? null,
      path: base.c.req.path,
    },
  } as never;
  return base;
}

async function runTurn(
  agentSource: string,
  adapter: typeof DEFAULT_SESSION_ADAPTER,
  threadId: string | null,
  body: Record<string, unknown>,
  traceId?: string,
): Promise<SessionTurnResult> {
  const ctx = makeCtx({
    agentSource,
    body,
    traceId,
    keyIdOverride: "k1",
  });
  const finalCtx = threadId ? withThread(ctx, threadId) : ctx;
  return prepareSessionTurn(finalCtx, adapter);
}

describe("prepareSessionTurn：4 入口共用会话编排（公共断言）", () => {
  beforeEach(() => {
    __resetAutoSessionForTests();
    __setAutoSessionNow(() => 1_000_000);
  });
  afterAll(() => {
    __resetAutoSessionForTests();
    __setAutoSessionNow(() => Date.now());
  });

  it("DEFAULT（CC/Chat）：显式会话 + 同线程 → 同一 compositeKey；不同线程隔离", async () => {
    const body = { messages: [{ role: "user", content: "hi" }], model: "m" };
    const a1 = await runTurn("claude-code", DEFAULT_SESSION_ADAPTER, "th-1", body);
    const a2 = await runTurn("claude-code", DEFAULT_SESSION_ADAPTER, "th-1", body);
    const b1 = await runTurn("claude-code", DEFAULT_SESSION_ADAPTER, "th-2", body);
    // DEFAULT 适配器把 x-thread-id 同时作为会话头回退（既有语义），
    // 这里验证的是“线程进入会话键/复合键”的不变量，而不是 auto 生成。
    expect(a1.sessionKey).toBe("th-1");
    expect(a1.threadId).toBe("th-1");
    expect(a1.compositeKey).toContain("claude-code:");
    expect(a2.compositeKey).toBe(a1.compositeKey);
    expect(b1.compositeKey).not.toBe(a1.compositeKey);
  });

  it("RESPONSES（codex）：同 key/同 thread 续接同一 compositeKey；不同 thread 隔离", async () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    const c1 = await runTurn("codex", RESPONSES_SESSION_ADAPTER, "th-1", body, "t1");
    const c2 = await runTurn("codex", RESPONSES_SESSION_ADAPTER, "th-1", body, "t2");
    const d1 = await runTurn("codex", RESPONSES_SESSION_ADAPTER, "th-2", body, "t3");
    expect(c2.compositeKey).toBe(c1.compositeKey);
    expect(d1.compositeKey).not.toBe(c1.compositeKey);
  });

  it("WORKBUDDY：alias 归一为 codex 前缀，同线程稳定、跨线程隔离", async () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    const w1 = await runTurn("workbuddy", WORKBUDDY_SESSION_ADAPTER, "th-1", body, "w1");
    const w2 = await runTurn("workbuddy", WORKBUDDY_SESSION_ADAPTER, "th-1", body, "w2");
    const w3 = await runTurn("workbuddy", WORKBUDDY_SESSION_ADAPTER, "th-2", body, "w3");
    expect(w1.compositeKey).toContain("codex:");
    expect(w2.compositeKey).toBe(w1.compositeKey);
    expect(w3.compositeKey).not.toBe(w1.compositeKey);
  });
});
