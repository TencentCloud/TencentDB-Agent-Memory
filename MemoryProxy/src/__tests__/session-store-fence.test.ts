/**
 * SessionStore 归属 fencing：跨用户同 keyId 的 L1 恢复隔离（写侧校验见
 * stages/archive.ts 的 writeL0 fence，走 getBoundIdentity + L1 兜底）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionStore,
  buildStoreSessionKey,
  type SessionIdentity,
} from "../session/store.js";
import type { SessionInitState } from "../session/types.js";

function makeIdentity(over: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    userId: "u1",
    agentSource: "claude-code",
    sessionId: "c1",
    spaceId: "sp1",
    ...over,
  };
}

function makeState(over: Partial<SessionInitState> = {}): SessionInitState {
  return {
    status: "initialized",
    keyId: "c1",
    startedAt: 1_000_000,
    attemptCount: 0,
    userId: "u1",
    sessionInfo: {
      session_id: "c1",
      user_id: "u1",
      team_id: "t1",
      agent_id: "a1",
      space_id: "sp1",
    },
    ...over,
  };
}

describe("SessionStore L1 恢复归属隔离", () => {
  let store: SessionStore;

  beforeEach(() => {
    // 无 repo / bindingRepo：纯 L1 路径（也覆盖 repo 降级时的兜底分支）。
    store = new SessionStore(30 * 60 * 1000);
  });

  it("同一 keyId：本人恢复命中，跨用户恢复返回 undefined（不泄漏他人会话态）", async () => {
    const identityA = makeIdentity();
    store.bind("c1", identityA);
    await store.set("c1", makeState());

    const mine = await store.getOrRecover("c1", identityA, {});
    expect(mine?.sessionInfo?.user_id).toBe("u1");

    const identityB = makeIdentity({ userId: "u2" });
    const other = await store.getOrRecover("c1", identityB, {});
    expect(other).toBeUndefined();
  });

  it("跨 space 的 L1 状态同样不恢复给异 space 调用者", async () => {
    const identityA = makeIdentity();
    store.bind("c1", identityA);
    await store.set("c1", makeState());

    const otherSpace = await store.getOrRecover(
      "c1",
      makeIdentity({ spaceId: "sp2" }),
      {},
    );
    expect(otherSpace).toBeUndefined();
  });
});

describe("buildStoreSessionKey（store 复合键单点约定）", () => {
  it("默认 = agentSource:sessionKey", () => {
    expect(buildStoreSessionKey({ agentSource: "claude-code", sessionKey: "sk" })).toBe(
      "claude-code:sk",
    );
  });

  it("workbuddy 别名 → codex:sessionKey（状态机复用 codex）", () => {
    expect(buildStoreSessionKey({ agentSource: "workbuddy", sessionKey: "sk" })).toBe(
      "codex:sk",
    );
  });

  it("threadIsolation 开启且有 threadId → 追加 :thread 后缀；未开启则忽略", () => {
    expect(
      buildStoreSessionKey({
        agentSource: "codex",
        sessionKey: "sk",
        threadId: "th1",
        threadIsolation: true,
      }),
    ).toBe("codex:sk:th1");
    expect(
      buildStoreSessionKey({
        agentSource: "codex",
        sessionKey: "sk",
        threadId: "th1",
        threadIsolation: false,
      }),
    ).toBe("codex:sk");
  });
});
