import { describe, expect, it } from "vitest";
import { RedisBindingRepo, type SessionBinding } from "../../db/binding-repo.js";
import { KvBindingRepo } from "../../db/kv-binding-repo.js";
import { MemoryStorage } from "../../storage/memory-storage.js";
import { SessionStore } from "../store.js";

// 保留 Redis 的 HSET 合并语义，检测 tombstone 写入是否遗留旧字段。
function redisHash() {
  const rows = new Map<string, Record<string, string>>();
  return {
    async hgetall(key: string) { return { ...rows.get(key) }; },
    async hset(key: string, fields: Record<string, string> | string, value?: string) {
      rows.set(key, { ...rows.get(key), ...(typeof fields === "string" ? { [fields]: value! } : fields) });
    },
    async expire() {},
    async del(key: string) { rows.delete(key); },
  };
}

describe.each(["kv", "redis"])("%s binding 歧义持久化", backend => {
  it("普通写入/touch/owner reset 保留标记，清除 owner 的旧资产，foreign delete 保留 tombstone", async () => {
    const storage = new MemoryStorage();
    const redis = redisHash();
    const makeRepo = () => backend === "kv" ? new KvBindingRepo(storage) : new RedisBindingRepo(redis as never);
    const bindings = makeRepo();
    const alice = { spaceId: "space-a", userId: "alice", agentSource: "openclaw", sessionId: "same" };
    const binding: SessionBinding = { outcome: "initialized", userId: "alice", agentSource: "openclaw", teamId: "team-a", agentId: "agent-a", taskId: "task-a", userKey: "test-only-key" };
    await bindings.putBinding("space-a", "same", binding);
    expect(await bindings.getBinding("space-a", "same")).toEqual(binding);
    await bindings.putBinding("space-a", "same", { ...binding, identityAmbiguous: true });
    await bindings.putBinding("space-a", "same", { ...binding, identityAmbiguous: false });
    await bindings.touchLastSeen("space-a", "same");
    expect(await makeRepo().getBinding("space-a", "same")).toEqual({ ...binding, identityAmbiguous: true });
    const store = new SessionStore(1000, undefined, makeRepo());
    await store.forIdentity(alice).deleteOwnedBinding();
    const tombstone = { outcome: "initialized", userId: "alice", agentSource: "openclaw", identityAmbiguous: true };
    expect(await makeRepo().getBinding("space-a", "same")).toEqual(tombstone);
    await store.forIdentity({ ...alice, userId: "bob" }).deleteOwnedBinding();
    expect(await makeRepo().getBinding("space-a", "same")).toEqual(tombstone);
    expect(await store.getOrRecover("openclaw:same", alice, {})).toBeUndefined();
  });

  it.each(["agent", "task"])("同 owner 的 %s 失效保留歧义但不恢复失效资产", async invalid => {
    const bindings = backend === "kv" ? new KvBindingRepo(new MemoryStorage()) : new RedisBindingRepo(redisHash() as never);
    const alice = { spaceId: "space-a", userId: "alice", agentSource: "openclaw", sessionId: "same" };
    await bindings.putBinding("space-a", "same", { outcome: "initialized", ...alice, agentId: "agent-a", taskId: "task-a", identityAmbiguous: true });
    const store = new SessionStore(1000, undefined, bindings);
    const result = await store.getOrRecover("openclaw:same", alice, { metadataClient: {
      async getAgent() { if (invalid === "agent") throw { notFound: true }; return { agent_id: "agent-a", name: "Alice" }; },
      async getTask() { if (invalid === "task") throw { notFound: true }; return { task_id: "task-a", title: "Task" }; },
    } as never });
    expect(await bindings.getBinding("space-a", "same")).toMatchObject({ identityAmbiguous: true, userId: "alice" });
    if (invalid === "agent") {
      expect(result).toBeUndefined();
      expect((await bindings.getBinding("space-a", "same"))?.agentId).toBeUndefined();
    } else {
      expect(result).toMatchObject({ sessionInfo: { user_id: "alice", agent_id: "agent-a" }, taskDetail: null });
      expect((await bindings.getBinding("space-a", "same"))?.taskId).toBeUndefined();
    }
  });
});
