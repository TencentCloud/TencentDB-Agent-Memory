import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { KvBindingRepo } from "../../db/kv-binding-repo.js";
import { KvSessionRepo } from "../../db/kv-session-repo.js";
import { setSessionRepo, __resetSessionRepoForTests } from "../../db/sessionRepo.js";
import { FsStorage } from "../../storage/fs-storage.js";
import { createMemoryBridgeHandler } from "../../memory/memory-bridge.js";
import { createSkillBridgeHandler } from "../../skill/skill-bridge.js";
import { executeSessionReset } from "../../mem-command/commands/session-reset.js";
import { SessionStore, getSessionStore, __resetSessionStoreForTests } from "../store.js";
import { WebSessionInitService } from "../web-init.js";

const alice = { spaceId: "space-a", userId: "alice", agentSource: "openclaw", sessionId: "same" };
const bob = { ...alice, userId: "bob" };
const key = "openclaw:same";
const directories: string[] = [];

async function fixture(spaceId = "space-a") {
  const directory = await mkdtemp(join(tmpdir(), "session-collision-"));
  directories.push(directory);
  const storage = new FsStorage(directory);
  const repo = new KvSessionRepo(storage);
  const bindings = new KvBindingRepo(storage);
  setSessionRepo(repo);
  __resetSessionStoreForTests();
  const store = getSessionStore();
  store.setBindingRepo(bindings);
  const service = new WebSessionInitService();
  async function init(userId: string) {
    const issued = service.issue({
      compositeKey: key, sessionKey: "same", identity: { ...alice, userId, spaceId }, store,
      metadataClient: {
        async listTeams() { return [{ team_id: `${userId}-team`, name: userId }]; },
        async listAgents() { return [{ agent_id: `${userId}-agent`, name: userId }]; },
        async listTasks() { return [{ task_id: `${userId}-task`, title: userId }]; },
      } as never,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error(issued.code);
    expect(await service.complete(issued.value.token, { teamId: `${userId}-team`, agentId: `${userId}-agent`, taskId: `${userId}-task` })).toEqual({ ok: true, value: null });
  }
  const config = structuredClone(DEFAULT_CONFIG);
  config.coreSkill.endpoint = "http://core.test";
  config.tdai!.serviceId = spaceId;
  config.coreSkill.serviceId = spaceId;
  config.redis.enabled = false;
  config.storage.enabled = false;
  const fetchMock = vi.fn(async () => Response.json({ code: 0, data: {} }));
  const app = new Hono();
  app.all("/memory-bridge/*", createMemoryBridgeHandler(config, { fetcher: fetchMock }));
  app.all("/skill-bridge/*", createSkillBridgeHandler(config, { fetcher: fetchMock }));
  async function bridge(path: string, session = "same") {
    const headers: Record<string, string> = { "content-type": "application/json", "x-conversation-id": session };
    if (spaceId) headers["x-tdai-service-id"] = spaceId;
    return app.request(path, { method: "POST", headers, body: "{}" });
  }
  return { directory, storage, repo, bindings, store, init, bridge, fetchMock };
}

afterEach(async () => {
  __resetSessionStoreForTests();
  __resetSessionRepoForTests();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const paths = ["/memory-bridge/v3/atomic/query", "/skill-bridge/v3/skill/get"];

describe("单槽 binding 的持久化冲突降级", () => {
  it("Alice binding 不阻塞 Bob Web Init / L2a，双方 restart / hydrate 后独立 resume", async () => {
    const f = await fixture();
    await f.init("alice");
    const original = await f.bindings.getBinding("space-a", "same");
    await f.init("bob");
    expect(await f.bindings.getBinding("space-a", "same")).toEqual({ ...original, identityAmbiguous: true });
    for (const hydrate of [false, true]) {
      const restarted = new SessionStore(1000, new KvSessionRepo(new FsStorage(f.directory)), new KvBindingRepo(new FsStorage(f.directory)));
      if (hydrate) expect(await restarted.hydrateFromDb()).toBe(2);
      for (const identity of [alice, bob]) {
        const state = await restarted.getOrRecover(key, identity, {});
        expect(state?.__recoverySource).toBe("l2a");
        expect(state?.sessionInfo).toMatchObject({ user_id: identity.userId, team_id: `${identity.userId}-team`, agent_id: `${identity.userId}-agent`, task_id: `${identity.userId}-task` });
        expect(state?.agentDetail?.id).toBe(`${identity.userId}-agent`);
        expect(state?.taskDetail?.id).toBe(`${identity.userId}-task`);
      }
    }
  });

  it.each(paths)("collision → 冷启动（无 hydrate/L2a）→ %s 拒绝，包括唯一 L1", async path => {
    const f = await fixture();
    await f.init("alice");
    // 无冲突的旧协议保持可用。
    expect((await f.bridge(path)).status).toBe(200);
    f.fetchMock.mockClear();
    await f.init("bob");
    expect((await f.bridge(path)).status).toBe(401);
    // 模拟 COS 禁用 hydrate，binding 必须足够拒绝，不能依赖 scope 数量。
    setSessionRepo({ upsert: async () => {}, getBySessionId: async () => null, deleteBySessionId() {}, loadAllInitialized: async () => [] });
    __resetSessionStoreForTests();
    const cold = getSessionStore();
    cold.setBindingRepo(new KvBindingRepo(new FsStorage(f.directory)));
    expect((await f.bridge(path)).status).toBe(401);
    const own = await f.repo.getBySessionId("space-a", "alice", "openclaw", "same");
    await cold.forIdentity(alice).set(key, own!);
    expect((await f.bridge(path)).status).toBe(401);
    expect((await f.bridge(path, key)).status).toBe(401);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it.each(paths)("默认空间冷启动仍通过 %s 的唯一 binding 回退", async path => {
    const f = await fixture("");
    await f.init("alice");
    setSessionRepo({ upsert: async () => {}, getBySessionId: async () => null, deleteBySessionId() {}, loadAllInitialized: async () => [] });
    __resetSessionStoreForTests();
    const cold = getSessionStore();
    cold.setBindingRepo(f.bindings);
    expect((await f.bridge(path)).status).toBe(200);
  });

  it("foreign delete/reset 保留资产；owner reset 留歧义 tombstone；重新初始化不清标记", async () => {
    const f = await fixture();
    await f.init("alice");
    await f.init("bob");
    const collided = await f.bindings.getBinding("space-a", "same");
    const reset = async (userId: string) => executeSessionReset({ spaceId: "space-a", userId, agentSource: "openclaw", sessionKey: "same", protocol: "openai", stream: false } as never);
    await reset("bob");
    expect(await f.bindings.getBinding("space-a", "same")).toEqual(collided);
    expect(await f.store.getOrRecover(key, bob, {})).toMatchObject({ status: "uninitialized", resetFlow: true });
    expect(await f.store.getOrRecover(key, alice, {})).toMatchObject({ sessionInfo: { user_id: "alice" } });
    f.store.forIdentity(bob).delete(key);
    await vi.waitFor(async () => expect(await f.repo.getBySessionId("space-a", "bob", "openclaw", "same")).toBeNull());
    await f.store.forIdentity(bob).deleteOwnedBinding();
    expect(await f.bindings.getBinding("space-a", "same")).toEqual(collided);
    await f.init("bob");
    await reset("alice");
    expect(await f.store.getOrRecover(key, bob, {})).toMatchObject({ sessionInfo: { user_id: "bob" } });
    expect(await f.bindings.getBinding("space-a", "same")).toEqual({ outcome: "initialized", userId: "alice", agentSource: "openclaw", identityAmbiguous: true });
    const cold = new SessionStore(1000, undefined, f.bindings);
    expect(await cold.getOrRecover(key, alice, {})).toBeUndefined();
    expect(await cold.getOrRecover(key, bob, {})).toBeUndefined();
    await f.init("alice");
    expect(await f.bindings.getBinding("space-a", "same")).toMatchObject({ userId: "alice", agentId: "alice-agent", identityAmbiguous: true });
    await f.bindings.touchLastSeen("space-a", "same");
    expect(await f.bindings.getBinding("space-a", "same")).toMatchObject({ identityAmbiguous: true });
  });

  it.each(paths)("%s 的 composite 别名在读取期间进入 L1，也必须检查 bare key 的 marker", async path => {
    const f = await fixture();
    await f.init("alice");
    await f.init("bob");
    setSessionRepo({ upsert: async () => {}, getBySessionId: async () => null, deleteBySessionId() {}, loadAllInitialized: async () => [] });
    __resetSessionStoreForTests();
    const cold = getSessionStore();
    cold.setBindingRepo(f.bindings);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = f.bindings.getBinding.bind(f.bindings);
    vi.spyOn(f.bindings, "getBinding").mockImplementation(async (spaceId, sessionId) => {
      if (sessionId === key) { entered(); await gate; return null; }
      return original(spaceId, sessionId);
    });
    const request = f.bridge(path, key);
    await started;
    const state = await f.repo.getBySessionId("space-a", "alice", "openclaw", "same");
    await cold.forIdentity(alice).set(key, state!);
    release();
    expect((await request).status).toBe(401);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it("同时初始化两个 owner，L2a 均成功，单槽保留首次 owner 并记歧义", async () => {
    const f = await fixture();
    await Promise.all([f.init("alice"), f.init("bob")]);
    const binding = await f.bindings.getBinding("space-a", "same");
    expect(["alice", "bob"]).toContain(binding?.userId);
    expect(binding?.identityAmbiguous).toBe(true);
    for (const identity of [alice, bob]) {
      expect(await f.repo.getBySessionId("space-a", identity.userId, "openclaw", "same")).toMatchObject({ sessionInfo: { user_id: identity.userId, agent_id: `${identity.userId}-agent` } });
    }
  });
});
