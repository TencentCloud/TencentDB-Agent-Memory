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
describe("SessionStore L1 有界淘汰", () => {
  it("超过 maxL1Entries 后按最近使用序淘汰最旧条目（不动持久层）", async () => {
    const store = new SessionStore(30_000, undefined, undefined, 3);
    const mk = (i: number) =>
      ({
        status: "initialized",
        keyId: `c${i}`,
        startedAt: 1_000_000,
        attemptCount: 0,
        userId: "u1",
        sessionInfo: { user_id: "u1", space_id: "sp1" },
      }) as SessionInitState;
    for (let i = 0; i < 5; i++) {
      store.bind(`claude-code:c${i}`, {
        userId: "u1",
        agentSource: "claude-code",
        sessionId: `c${i}`,
        spaceId: "sp1",
      });
      await store.set(`claude-code:c${i}`, mk(i));
    }
    const states = (store as unknown as { states: Map<string, SessionInitState> }).states;
    expect(states.size).toBeLessThanOrEqual(3);
    expect(store.get("claude-code:c0")).toBeUndefined();
    expect(store.get("claude-code:c4")).toBeDefined();
  });

  it("刷新已存在 key 会移到最近使用，不被误淘汰", async () => {
    const store = new SessionStore(30_000, undefined, undefined, 2);
    const mk = (i: number) =>
      ({
        status: "initialized",
        keyId: `c${i}`,
        startedAt: 1_000_000,
        attemptCount: 0,
        userId: "u1",
        sessionInfo: { user_id: "u1", space_id: "sp1" },
      }) as SessionInitState;
    store.bind("claude-code:a", { userId: "u1", agentSource: "claude-code", sessionId: "a", spaceId: "sp1" });
    store.bind("claude-code:b", { userId: "u1", agentSource: "claude-code", sessionId: "b", spaceId: "sp1" });
    await store.set("claude-code:a", mk(0));
    await store.set("claude-code:b", mk(1));
    // 刷新 a（移到最新）后再插入 c → 应淘汰 b
    await store.set("claude-code:a", mk(0));
    await store.set("claude-code:c", mk(2));
    expect(store.get("claude-code:b")).toBeUndefined();
    expect(store.get("claude-code:a")).toBeDefined();
    expect(store.get("claude-code:c")).toBeDefined();
  });
});
