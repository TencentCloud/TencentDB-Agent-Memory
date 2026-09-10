import { afterEach, describe, expect, it, vi } from "vitest";
import type { BindingRepo, SessionBinding } from "../../db/binding-repo.js";
import type { HydratedSessionRow, SessionRepo } from "../../db/sessionRepo.js";
import { SessionStore, sessionIdentityKey, type SessionIdentity } from "../store.js";
import type { SessionInitState } from "../types.js";
import { DEFAULT_CONFIG } from "../../config.js";
import { handleSessionInit as claudeInit } from "../claude-code/init.js";

const alice: SessionIdentity = { spaceId: "space-a", userId: "alice", agentSource: "openclaw", sessionId: "same" };
const bob = { ...alice, userId: "bob" };
const compositeKey = "openclaw:same";

function stateFor(identity: SessionIdentity, status: SessionInitState["status"] = "initialized", bypassed = false): SessionInitState {
  return {
    keyId: identity.sessionId, status, startedAt: Date.now(), attemptCount: 0,
    userId: identity.userId, bypassed,
    sessionInfo: bypassed || status !== "initialized" ? null : {
      session_id: identity.sessionId, user_id: identity.userId, space_id: identity.spaceId,
      team_id: `${identity.userId}-team`, agent_id: `${identity.userId}-agent`,
      task_id: `${identity.userId}-task`, created_at: new Date().toISOString(),
    },
    agentDetail: bypassed ? null : { id: `${identity.userId}-agent`, name: identity.userId },
    taskDetail: bypassed ? null : { id: `${identity.userId}-task`, name: identity.userId },
  };
}

class SessionMemory implements SessionRepo {
  rows = new Map<string, HydratedSessionRow>();
  miss = false;
  fail = false;
  async upsert(spaceId: string, userId: string, agentSource: string, sessionId: string, state: SessionInitState) {
    this.rows.set(JSON.stringify([spaceId, userId, agentSource, sessionId]), { spaceId, userId, agentSource, sessionId, state });
  }
  async getBySessionId(...identity: [string, string, string, string]) {
    if (this.fail) throw new Error("unavailable");
    return this.miss ? null : this.rows.get(JSON.stringify(identity))?.state ?? null;
  }
  deleteBySessionId(...identity: [string, string, string, string]) { this.rows.delete(JSON.stringify(identity)); }
  async loadAllInitialized() { return [...this.rows.values()].filter(row => row.state.status === "initialized"); }
}

class BindingMemory implements BindingRepo {
  rows = new Map<string, SessionBinding>();
  async getBinding(space: string, session: string) { return this.rows.get(JSON.stringify([space, session])) ?? null; }
  async putBinding(space: string, session: string, binding: SessionBinding) { this.rows.set(JSON.stringify([space, session]), binding); }
  async deleteBinding(space: string, session: string) { this.rows.delete(JSON.stringify([space, session])); }
  async touchLastSeen() {}
}

describe("完整 Session identity 隔离", () => {
  afterEach(() => vi.useRealTimers());

  it("Claude Code debugForceIdentity 的匿名调用与 scope 身份保持一致", async () => {
    const store = new SessionStore();
    const result = await claudeInit("debug-session", null, [], {
      ...DEFAULT_CONFIG.sessionInit,
      debugForceIdentity: { team_id: "debug-team", agent_id: "debug-agent" },
    }, store, { stream: false, modelId: "test" });
    expect(result.sessionInfo?.user_id).toBe("anonymous");
    expect(store.findSession("", "debug-session", "claude-code", "anonymous")?.get("claude-code:debug-session")?.status).toBe("initialized");
  });

  it("只读 missing lookup 不创建 L1 状态", () => {
    const store = new SessionStore();
    for (let i = 0; i < 1000; i++) {
      expect(store.findSession("space-a", "same", "openclaw", `user-${i}`)).toBeUndefined();
    }
    expect((store as any).states.size).toBe(0);
  });

  it("cleanup 只回收过期 pending，并保留 initialized state", async () => {
    vi.useFakeTimers();
    const store = new SessionStore(100);
    await store.forIdentity(alice).set(compositeKey, stateFor(alice));
    for (let i = 0; i < 1000; i++) {
      const identity = { ...bob, userId: `user-${i}` };
      await store.forIdentity(identity).set(compositeKey, stateFor(identity, "pending_team_select"));
    }
    vi.advanceTimersByTime(101);
    store.cleanup();
    expect((store as any).states.size).toBe(1);
    expect(store.forIdentity(alice).get(compositeKey)?.userId).toBe("alice");
  });

  it("不同视图读写汇合到同一完整身份 L1", async () => {
    const store = new SessionStore();
    const first = store.forIdentity(alice);
    const second = store.forIdentity(alice);
    expect(first).not.toBe(second);
    await first.set(compositeKey, stateFor(alice));
    expect(second.get(compositeKey)).toBe(first.get(compositeKey));
    await second.set(compositeKey, { ...stateFor(alice), attemptCount: 4 });
    expect(first.get(compositeKey)?.attemptCount).toBe(4);
  });

  it("身份序列化无分隔符碰撞，默认空间归一化，视图身份不可重绑", async () => {
    const store = new SessionStore();
    expect(sessionIdentityKey({ ...alice, spaceId: "one:two", userId: "three" }))
      .not.toBe(sessionIdentityKey({ ...alice, spaceId: "one", userId: "two:three" }));
    await store.forIdentity({ ...alice, spaceId: "" }).set(compositeKey, stateFor({ ...alice, spaceId: "" }));
    expect(store.forIdentity({ ...alice, spaceId: "_default" }).get(compositeKey)?.userId).toBe("alice");
    const scoped = store.forIdentity(alice);
    expect(() => scoped.bind(compositeKey, bob)).toThrow("identity mismatch");
    await expect(scoped.set(compositeKey, stateFor(bob))).rejects.toThrow("identity mismatch");
    expect(() => store.bind(compositeKey, alice)).toThrow("forIdentity");
  });

  it("缺少用户身份的旧入口只允许空间内唯一匹配，歧义不选择任意 owner", async () => {
    const store = new SessionStore();
    await store.forIdentity(alice).set(compositeKey, stateFor(alice));
    expect(store.findSession("space-a", "same")?.get(compositeKey)?.userId).toBe("alice");
    expect(store.findSession("space-a", compositeKey)?.get(compositeKey)?.userId).toBe("alice");
    expect(store.findSession("space-b", "same")).toBeUndefined();
    await store.forIdentity(bob).set(compositeKey, stateFor(bob));
    expect(store.findSession("space-a", "same")).toBeNull();
    expect(store.findSession("space-a", "same", "openclaw", "bob")?.get(compositeKey)?.userId).toBe("bob");
  });

  it("丢弃旧版本遗留的异主 L2a/hydrate 数据，不污染当前身份 L1", async () => {
    const repo = new SessionMemory();
    await repo.upsert("space-a", "bob", "openclaw", "same", stateFor(alice));
    const store = new SessionStore(30_000, repo);
    expect(await store.hydrateFromDb()).toBe(0);
    expect(await store.getOrRecover(compositeKey, bob, {})).toBeUndefined();
    expect(store.forIdentity(bob).get(compositeKey)).toBeUndefined();
  });

  it("异客户端来源和缺失 owner 的旧 binding 不恢复或删除", async () => {
    for (const binding of [
      { outcome: "initialized", userId: "alice", agentSource: "claude-code", agentId: "alice-agent" },
      { outcome: "bypassed", userId: "alice" },
    ] satisfies SessionBinding[]) {
      const bindings = new BindingMemory();
      await bindings.putBinding("space-a", "same", binding);
      const store = new SessionStore(30_000, new SessionMemory(), bindings);
      expect(await store.getOrRecover(compositeKey, alice, {})).toBeUndefined();
      await store.forIdentity(alice).deleteOwnedBinding();
      expect(await bindings.getBinding("space-a", "same")).toEqual({ ...binding, identityAmbiguous: true });
    }
  });

  it("相同用户/空间/会话的不同 agentSource 独立保存并恢复", async () => {
    const repo = new SessionMemory();
    const bindings = new BindingMemory();
    const store = new SessionStore(30_000, repo, bindings);
    const other = { ...alice, agentSource: "claude-code" };
    await store.forIdentity(alice).set(compositeKey, stateFor(alice));
    expect(await store.getOrRecover("claude-code:same", other, {})).toBeUndefined();
    await store.forIdentity(other).set("claude-code:same", { ...stateFor(other), attemptCount: 7 });
    expect(store.forIdentity(alice).get(compositeKey)?.attemptCount).toBe(0);
    const restarted = new SessionStore(30_000, repo, bindings);
    expect(await restarted.getOrRecover(compositeKey, alice, {})).toMatchObject({ attemptCount: 0 });
    expect(await restarted.getOrRecover("claude-code:same", other, {})).toMatchObject({ attemptCount: 7 });
    expect((await bindings.getBinding("space-a", "same"))?.agentSource).toBe("openclaw");
  });

  it("过期 pending 与清理只删除所属身份，默认空间持久化路径一致", async () => {
    const repo = new SessionMemory();
    const store = new SessionStore(1, repo);
    await store.forIdentity(alice).set(compositeKey, { ...stateFor(alice, "pending_team_select"), startedAt: 0 });
    await store.forIdentity(bob).set(compositeKey, stateFor(bob));
    store.cleanup();
    expect(store.forIdentity(alice).get(compositeKey)).toBeUndefined();
    expect(await repo.getBySessionId("space-a", "alice", "openclaw", "same")).toBeNull();
    expect(store.forIdentity(bob).get(compositeKey)).toMatchObject({ userId: "bob" });
    const defaultIdentity = { ...alice, spaceId: "_default" };
    await store.forIdentity(defaultIdentity).set(compositeKey, stateFor(defaultIdentity));
    expect(await store.getOrRecover(compositeKey, defaultIdentity, {})).toMatchObject({ __recoverySource: "l2a" });
  });

  it.each([
    ["不同用户", bob], ["不同空间", { ...alice, spaceId: "space-b" }],
  ])("%s 同 session key 不命中异主 L1，原身份仍可 resume", async (_name, other) => {
    const repo = new SessionMemory();
    const store = new SessionStore(30_000, repo);
    const aliceStore = store.forIdentity(alice);
    await aliceStore.set(compositeKey, stateFor(alice));
    repo.miss = true;
    expect(await store.getOrRecover(compositeKey, other, {})).toBeUndefined();
    expect(store.forIdentity(other).get(compositeKey)).toBeUndefined();
    expect(await store.getOrRecover(compositeKey, alice, {})).toMatchObject({ sessionInfo: { user_id: "alice" } });
    expect(store.get(compositeKey)).toBeUndefined();
  });

  it.each(["initialized", "pending_team_select", "bypassed"] as const)("%s 在 L2a miss/error 与交错写入时保持身份", async status => {
    const repo = new SessionMemory();
    const store = new SessionStore(30_000, repo);
    const aliceStore = store.forIdentity(alice);
    const bobStore = store.forIdentity(bob);
    const state = stateFor(alice, status === "bypassed" ? "initialized" : status, status === "bypassed");
    await aliceStore.set(compositeKey, state);
    await store.getOrRecover(compositeKey, bob, {});
    await aliceStore.set(compositeKey, { ...state, attemptCount: 2 });
    expect(await repo.getBySessionId("space-a", "alice", "openclaw", "same")).toMatchObject({ userId: "alice", attemptCount: 2 });
    expect(await repo.getBySessionId("space-a", "bob", "openclaw", "same")).toBeNull();
    repo.fail = true;
    expect(await bobStore.getOrRecover(compositeKey, bob, {})).toBeUndefined();
    expect(await aliceStore.getOrRecover(compositeKey, alice, {})).toMatchObject({ userId: "alice", attemptCount: 2 });
    bobStore.delete(compositeKey);
    expect(aliceStore.get(compositeKey)).toMatchObject({ userId: "alice" });
  });

  it("hydrate 和重启后的 L2a 恢复不合并相同会话的身份", async () => {
    const repo = new SessionMemory();
    const identities = [alice, bob, { ...alice, spaceId: "space-b" }];
    for (const identity of identities) {
      await repo.upsert(identity.spaceId!, identity.userId, identity.agentSource, identity.sessionId, stateFor(identity));
    }
    const store = new SessionStore(30_000, repo);
    expect(await store.hydrateFromDb()).toBe(3);
    repo.miss = true;
    for (const identity of identities) {
      expect(await store.getOrRecover(compositeKey, identity, {})).toMatchObject({ sessionInfo: { user_id: identity.userId, space_id: identity.spaceId } });
    }
    repo.miss = false;
    const restarted = new SessionStore(30_000, repo);
    for (const identity of identities) {
      expect(await restarted.getOrRecover(compositeKey, identity, {})).toMatchObject({ sessionInfo: { user_id: identity.userId, space_id: identity.spaceId } });
    }
  });

  it.each(["initialized", "bypassed"] as const)("异主 %s binding 不恢复、不覆盖、不删除", async outcome => {
    const repo = new SessionMemory();
    const bindings = new BindingMemory();
    const binding: SessionBinding = { outcome, userId: "alice", agentSource: "openclaw", teamId: "alice-team", agentId: "alice-agent" };
    await bindings.putBinding("space-a", "same", binding);
    const store = new SessionStore(30_000, repo, bindings);
    expect(await store.getOrRecover(compositeKey, bob, {})).toBeUndefined();
    await store.forIdentity(bob).set(compositeKey, stateFor(bob));
    store.forIdentity(bob).delete(compositeKey);
    await new Promise(resolve => setImmediate(resolve));
    expect(await bindings.getBinding("space-a", "same")).toEqual({ ...binding, identityAmbiguous: true });
  });

  it("并发冷恢复按完整身份去重，而不是复用其他用户 promise", async () => {
    const bindings = new BindingMemory();
    await bindings.putBinding("space-a", "same", { outcome: "initialized", userId: "alice", agentSource: "openclaw", teamId: "alice-team", agentId: "alice-agent" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const metadataClient = { async getAgent() { calls++; started(); await gate; return { agent_id: "alice-agent", name: "Alice" }; } };
    const store = new SessionStore(30_000, new SessionMemory(), bindings);
    const first = store.getOrRecover(compositeKey, alice, { metadataClient: metadataClient as never });
    await entered;
    store.cleanup();
    const second = store.getOrRecover(compositeKey, alice, { metadataClient: metadataClient as never });
    expect(await store.getOrRecover(compositeKey, bob, { metadataClient: metadataClient as never })).toBeUndefined();
    release();
    expect(await first).toMatchObject({ sessionInfo: { user_id: "alice" } });
    expect(await second).toMatchObject({ sessionInfo: { user_id: "alice" } });
    expect(calls).toBe(1);
  });

  it.each(["agent", "task"])("%s 失效的 await 窗口出现 foreign owner 时，不误删或覆盖资产", async invalid => {
    const bindings = new BindingMemory();
    const original: SessionBinding = { outcome: "initialized", userId: "alice", agentSource: "openclaw", agentId: "alice-agent", taskId: "alice-task" };
    await bindings.putBinding("space-a", "same", original);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const store = new SessionStore(1000, new SessionMemory(), bindings);
    const recovering = store.getOrRecover(compositeKey, alice, { metadataClient: {
      async getAgent() { entered(); await gate; if (invalid === "agent") throw { notFound: true }; return { agent_id: "alice-agent", name: "Alice" }; },
      async getTask() { await gate; if (invalid === "task") throw { notFound: true }; return { task_id: "alice-task", title: "Alice" }; },
    } as never });
    await started;
    // 模拟另一个实例在 metadata await 期间改变了单槽 owner。
    const foreign = { ...original, userId: "bob", agentId: "bob-agent", taskId: "bob-task" };
    await bindings.putBinding("space-a", "same", foreign);
    release();
    const result = await recovering;
    expect(await bindings.getBinding("space-a", "same")).toEqual({ ...foreign, identityAmbiguous: true });
    if (invalid === "agent") expect(result).toBeUndefined();
    else expect(result).toMatchObject({ sessionInfo: { user_id: "alice", agent_id: "alice-agent" }, taskDetail: null });
  });
});
