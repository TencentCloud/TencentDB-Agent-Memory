import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SqliteSkillStateStore } from "./skill-state-store.js";
import { PersistentSkillPublicationCoordinator } from "./skill-publication-coordinator.js";
import type { Skill } from "./types.js";

class AtomicMemoryState {
  rows = new Map<string, { revision: number; value: unknown }>();
  async init() {}
  async read(key: string) { return structuredClone(this.rows.get(key) ?? null); }
  async create(key: string, value: unknown) {
    if (this.rows.has(key)) return false;
    this.rows.set(key, { revision: 1, value: structuredClone(value) });
    return true;
  }
  async compareAndSet(key: string, revision: number, value: unknown) {
    if (this.rows.get(key)?.revision !== revision) return false;
    this.rows.set(key, { revision: revision + 1, value: structuredClone(value) });
    return true;
  }
  async remove(key: string, revision: number) {
    if (this.rows.get(key)?.revision !== revision) return false;
    return this.rows.delete(key);
  }
  async list(prefix: string, options: { limit?: number; after?: string } = {}) {
    const keys = [...this.rows.keys()].filter((k) => k.startsWith(prefix) && (!options.after || k > options.after)).sort();
    const selected = keys.slice(0, options.limit ?? 100);
    return { items: selected.map((key) => ({ key, ...structuredClone(this.rows.get(key)!) })), next: keys.length > selected.length ? selected.at(-1) : undefined };
  }
}

const scope = { skill_id: "skl-source", team_id: "team-a" };
function skill(version: number, row_id = `row-${version}`, overrides: Partial<Skill> = {}): Skill {
  return { ...scope, row_id, version, is_head: true, name: "database-guide", description: "Database diagnostics",
    content: "---\nname: database-guide\ndescription: Database diagnostics\n---\n\nCheck first.",
    content_hash: `hash-${version}`, manifest: [], storage_dir: `skills/source/attempt-${row_id}`,
    owner_agent_id: "agent-a", user_id: "user-a", task_id: "task-a", status: "active", metadata_json: "{}",
    created_at_ms: version, updated_at_ms: version, ...overrides };
}
function request(mutation_id = "update-a", expected_version = 1) {
  return { scope, mutation_id, payload_hash: `payload-${mutation_id}`, expected_version,
    name: "database-guide", owner_agent_id: "agent-a", previous_head: expected_version ? skill(expected_version) : null };
}
function fixture(now: () => number = () => Date.now()) {
  const store = new AtomicMemoryState();
  return { store, coordinator: new PersistentSkillPublicationCoordinator({ store, namespace: "instance-a", now, leaseMs: 1000, heartbeat: false }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("persistent skill publication", () => {
  it("keeps the previous head visible until a complete candidate is committed", async () => {
    const { coordinator } = fixture();
    const entered = deferred<void>();
    const prepared = deferred<Skill>();
    const pending = coordinator.execute(request(), async () => { entered.resolve(); return prepared.promise; });
    await entered.promise;
    expect(await coordinator.getHead(scope)).toMatchObject({ row_id: "row-1", version: 1 });
    prepared.resolve(skill(2));
    await pending;
    expect(await coordinator.getHead(scope)).toMatchObject({ row_id: "row-2", version: 2, mutation_id: "update-a" });
  });

  it("replays a committed intent across coordinator instances without preparing again", async () => {
    const { coordinator, store } = fixture();
    const prepare = vi.fn(async () => skill(2));
    await coordinator.execute(request(), prepare);
    const restarted = new PersistentSkillPublicationCoordinator({ store, namespace: "instance-a", heartbeat: false });
    expect(await restarted.execute(request(), prepare)).toMatchObject({ row_id: "row-2", version: 2 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await restarted.lookup(scope, "update-a")).toMatchObject({ status: "committed", payload_hash: "payload-update-a" });
  });

  it("rejects the same intent with a different payload", async () => {
    const { coordinator } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    await expect(coordinator.execute({ ...request(), payload_hash: "different" }, async () => skill(3)))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(await coordinator.getHead(scope)).toMatchObject({ version: 2 });
  });

  it("allows only one active preparation for a skill", async () => {
    const { coordinator } = fixture();
    const entered = deferred<void>();
    const prepared = deferred<Skill>();
    const pending = coordinator.execute(request(), async () => { entered.resolve(); return prepared.promise; });
    await entered.promise;
    await expect(coordinator.execute(request("update-b"), async () => skill(2, "loser")))
      .rejects.toMatchObject({ code: "SKILL_PUBLICATION_BUSY" });
    prepared.resolve(skill(2));
    await pending;
  });

  it("does not publish or lose the old head when preparation fails", async () => {
    const { coordinator } = fixture();
    await expect(coordinator.execute(request(), async () => { throw new Error("storage failed"); })).rejects.toThrow("storage failed");
    expect(await coordinator.getHead(scope)).toMatchObject({ version: 1 });
    expect(await coordinator.execute(request(), async () => skill(2))).toMatchObject({ version: 2 });
  });

  it("fences a late worker after its lease is replaced", async () => {
    let now = 100;
    const { coordinator } = fixture(() => now);
    const entered = deferred<void>();
    const prepared = deferred<Skill>();
    const late = coordinator.execute(request("old"), async () => { entered.resolve(); return prepared.promise; });
    const lateRejection = expect(late).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    await entered.promise;
    now = 1200;
    await coordinator.execute(request("new"), async () => skill(2, "winner"));
    prepared.resolve(skill(2, "late-row"));
    await lateRejection;
    expect(await coordinator.getHead(scope)).toMatchObject({ row_id: "winner" });
    expect(await coordinator.lookup(scope, "old")).toMatchObject({ status: "absent" });
  });

  it("rejects an obsolete expected version before calling prepare", async () => {
    const { coordinator } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const prepare = vi.fn(async () => skill(3));
    await expect(coordinator.execute(request("stale"), prepare)).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("recovers a committed pointer after the CAS acknowledgement is lost", async () => {
    const { coordinator, store } = fixture();
    const cas = store.compareAndSet.bind(store);
    let failed = false;
    vi.spyOn(store, "compareAndSet").mockImplementation(async (key, revision, value) => {
      const result = await cas(key, revision, value);
      if (!failed && result && (value as { kind?: string; receipt?: unknown }).kind === "head" && (value as { receipt?: unknown }).receipt) {
        failed = true;
        throw new Error("acknowledgement lost");
      }
      return result;
    });
    expect(await coordinator.execute(request(), async () => skill(2))).toMatchObject({ version: 2 });
    expect(await coordinator.lookup(scope, "update-a")).toMatchObject({ status: "committed", skill: { row_id: "row-2" } });
  });

  it("does not turn a concurrent confirmed commit into absence during recovery", async () => {
    let now = 100;
    const { coordinator, store } = fixture(() => now);
    const commitStarted = deferred<void>();
    const allowCommit = deferred<void>();
    const committed = deferred<void>();
    const acknowledge = deferred<void>();
    const cas = store.compareAndSet.bind(store);
    let paused = false;
    vi.spyOn(store, "compareAndSet").mockImplementation(async (key, revision, value) => {
      if (!paused && (value as { kind?: string; receipt?: unknown }).kind === "head" && (value as { receipt?: unknown }).receipt) {
        paused = true; commitStarted.resolve(); await allowCommit.promise;
        const result = await cas(key, revision, value); committed.resolve();
        await acknowledge.promise;
        return result;
      }
      return cas(key, revision, value);
    });
    const publishing = coordinator.execute(request(), async () => skill(2));
    await commitStarted.promise;
    now = 1200;
    const read = store.read.bind(store);
    let interleaved = false;
    vi.spyOn(store, "read").mockImplementation(async key => {
      const result = await read(key);
      if (!interleaved && (result?.value as { kind?: string }).kind === "head") {
        interleaved = true; allowCommit.resolve(); await committed.promise;
      }
      return result;
    });
    try {
      expect(await coordinator.lookup(scope, "update-a")).toMatchObject({ status: "committed", skill: { row_id: "row-2" } });
    } finally {
      acknowledge.resolve(); await publishing;
    }
  });

  it("cannot clear a deletion tombstone by archiving an old pointer", async () => {
    const { coordinator } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const pointer = (await coordinator.getHead(scope))!;
    await coordinator.remove(scope, pointer, async () => 2);
    await expect(coordinator.archive(scope, pointer, async () => {})).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(await coordinator.getHead(scope)).toBeNull();
    await expect(coordinator.execute(request("revive", 0), async () => skill(1))).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("stores valid optional DTO fields through the strict real SQLite adapter", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = new SqliteSkillStateStore(db);
      await store.init();
      const coordinator = new PersistentSkillPublicationCoordinator({ store, namespace: "sqlite-contract", heartbeat: false });
      const candidate = { ...skill(2), mutation_id: undefined, mutation_payload_hash: undefined, mutation_request_hash: undefined };
      expect(await coordinator.execute(request(), async () => candidate)).toMatchObject({ version: 2, is_head: true });
      expect(await coordinator.lookup(scope, "update-a")).toMatchObject({ status: "committed", skill: { version: 2 } });
    } finally { db.close(); }
  });

  it("keeps large bodies in the intent while every head write contains only a receipt reference", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = new SqliteSkillStateStore(db);
      await store.init();
      const coordinator = new PersistentSkillPublicationCoordinator({ store, namespace: "lightweight", heartbeat: false });
      const writes = vi.spyOn(store, "compareAndSet");
      const candidate = skill(2, "large-row", { content: "PRIVATE-LARGE-BODY".repeat(20_000) });
      await coordinator.execute(request(), async () => candidate);
      const heads = writes.mock.calls.filter(([key]) => key.includes("/head/")).map(([, , value]) => value);
      expect(heads.length).toBeGreaterThan(0);
      for (const head of heads) {
        expect(JSON.stringify(head).includes("PRIVATE-LARGE-BODY")).toBe(false);
        expect(JSON.stringify(head).length).toBeLessThan(2048);
      }
      const rows = db.prepare("SELECT key, value_json FROM skill_control").all();
      const head = JSON.parse(rows.find(row => (row.key as string).includes("/head/"))!.value_json as string);
      expect(head.receipt).toEqual({ mutation_id: "update-a", payload_hash: "payload-update-a", row_id: "large-row", version: 2 });
      const intent = JSON.parse(rows.find(row => (row.key as string).includes("/intent/"))!.value_json as string);
      expect(intent.phase).toBe("committed");
      expect(intent.skill.content).toBe(candidate.content);
    } finally { db.close(); }
  });

  it("reads old embedded receipts but compacts them on the next head write", async () => {
    const { coordinator, store } = fixture();
    const old = await coordinator.execute(request(), async () => skill(2));
    const head = [...store.rows.values()].find(row => (row.value as { kind: string }).kind === "head")!.value as Record<string, unknown>;
    head.receipt = { mutation_id: "update-a", payload_hash: "payload-update-a", skill: old };
    expect(await coordinator.getHeads([scope])).toEqual([{ row_id: "row-2", version: 2, mutation_id: "update-a", status: "active" }]);
    const writes = vi.spyOn(store, "compareAndSet");
    await coordinator.execute(request("next", 2), async () => skill(3));
    for (const [key, , value] of writes.mock.calls) {
      if (key.includes("/head/")) expect(JSON.stringify(value).includes('"content":')).toBe(false);
    }
    expect(await coordinator.lookup(scope, "update-a")).toMatchObject({ status: "committed", skill: { row_id: "row-2" } });
  });

  it("batches head projections in input order without reading any intent payload", async () => {
    const { coordinator, store } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const secondScope = { team_id: "team-b", skill_id: "skl-second" };
    await coordinator.execute({ ...request("second", 0), scope: secondScope }, async () => skill(1, "second-row", secondScope));
    await coordinator.remove(scope, (await coordinator.getHead(scope))!, async () => 1);
    const readMany = vi.fn(async (keys: string[]) => keys.map(key => structuredClone(store.rows.get(key) ?? null)));
    Object.assign(store, { readMany });
    vi.spyOn(store, "read").mockRejectedValue(new Error("single-key reads, especially intents, must not occur"));
    const result = await coordinator.getHeads([secondScope, { ...scope, skill_id: "missing" }, scope, secondScope, { ...secondScope, team_id: "wrong-team" }]);
    expect(result).toEqual([
      { row_id: "second-row", version: 1, mutation_id: "second", status: "active" }, undefined, null,
      { row_id: "second-row", version: 1, mutation_id: "second", status: "active" }, undefined,
    ]);
    expect(readMany).toHaveBeenCalledTimes(1);
    expect(readMany.mock.calls[0][0].every(key => key.includes("/head/") && !key.includes("/intent/"))).toBe(true);
    const other = new PersistentSkillPublicationCoordinator({ store, namespace: "another-instance", heartbeat: false });
    expect(await other.getHeads([secondScope])).toEqual([undefined]);
  });

  it("bounds fallback head-read concurrency without serializing every scope", async () => {
    const { coordinator, store } = fixture();
    let active = 0;
    let maximum = 0;
    vi.spyOn(store, "read").mockImplementation(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--;
      return null;
    });
    expect(await coordinator.getHeads(Array.from({ length: 40 }, (_, i) => ({ ...scope, skill_id: `missing-${i}` })))).toEqual(Array(40).fill(undefined));
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(await coordinator.getHeads([])).toEqual([]);
    await expect(coordinator.getHeads(Array(1001).fill(scope))).rejects.toThrow(/1000/);
  });

  it("propagates failed batches and rejects corrupt heads without falling back to unchecked reads", async () => {
    const { coordinator, store } = fixture();
    Object.assign(store, { readMany: vi.fn(async () => { throw new Error("batch database failure"); }) });
    await expect(coordinator.getHeads([scope])).rejects.toThrow("batch database failure");
    Object.assign(store, { readMany: vi.fn(async () => [{ revision: 1, value: { kind: "head", scope: { ...scope, team_id: "wrong" } } }]) });
    await expect(coordinator.getHeads([scope])).rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
  });

  it.each(["missing", "unprepared", "row", "version", "hash"])("never confirms a lightweight receipt with %s prepared intent data", async fault => {
    const { coordinator, store } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const [key, record] = [...store.rows.entries()].find(([key]) => key.includes("/intent/"))!;
    const value = record.value as { phase: string; payload_hash: string; skill: Skill };
    value.phase = "committing";
    if (fault === "missing") store.rows.delete(key);
    if (fault === "unprepared") value.phase = "preparing";
    if (fault === "row") value.skill.row_id = "another-attempt";
    if (fault === "version") value.skill.version++;
    if (fault === "hash") value.payload_hash = "another-payload";
    await expect(coordinator.lookup(scope, "update-a")).rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
    const prepare = vi.fn(async () => skill(3));
    await expect(coordinator.execute(request("next", 2), prepare)).rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
    expect(prepare).not.toHaveBeenCalled();
    expect(await coordinator.getHead(scope)).toMatchObject({ row_id: "row-2", version: 2 });
  });

  it("does not infer a commit from a complete prepared intent without a head receipt", async () => {
    let now = 100;
    const { coordinator, store } = fixture(() => now);
    await coordinator.execute(request(), async () => skill(2));
    const head = [...store.rows.values()].find(row => (row.value as { kind: string }).kind === "head")!.value as Record<string, unknown>;
    const intent = [...store.rows.values()].find(row => (row.value as { kind: string }).kind === "intent")!.value as Record<string, unknown>;
    delete head.receipt;
    head.pointer = { row_id: "row-1", version: 1, mutation_id: "legacy" };
    head.lease = { token: "pending", mutation_id: "update-a", expires_at: 1000 };
    intent.phase = "committing"; intent.token = "pending";
    expect(await coordinator.lookup(scope, "update-a")).toEqual({ status: "unknown" });
    now = 1200;
    expect(await coordinator.lookup(scope, "update-a")).toEqual({ status: "absent" });
    expect(await coordinator.getHead(scope)).toMatchObject({ row_id: "row-1", version: 1 });
  });

  it("keeps an unresolved intent without a fencing token unknown instead of declaring absence", async () => {
    const { coordinator, store } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const head = [...store.rows.values()].find(row => (row.value as { kind: string }).kind === "head")!.value as Record<string, unknown>;
    const intent = [...store.rows.values()].find(row => (row.value as { kind: string }).kind === "intent")!.value as Record<string, unknown>;
    delete head.receipt;
    head.lease = null;
    intent.phase = "committing";
    delete intent.token;
    expect(await coordinator.lookup(scope, "update-a")).toEqual({ status: "unknown" });
  });

  it("fences a late intent write so it cannot overwrite the prepared skill referenced by the winner", async () => {
    let now = 100;
    const { coordinator, store } = fixture(() => now);
    const oldReadStarted = deferred<void>();
    const resumeOldRead = deferred<void>();
    const winnerCommitted = deferred<void>();
    const acknowledgeWinner = deferred<void>();
    let pauseOldRead = false;
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementation(async key => {
      if (pauseOldRead && key.includes("/intent/")) {
        pauseOldRead = false; oldReadStarted.resolve(); await resumeOldRead.promise;
      }
      return read(key);
    });
    const cas = store.compareAndSet.bind(store);
    let heldWinner = false;
    vi.spyOn(store, "compareAndSet").mockImplementation(async (key, revision, value) => {
      const result = await cas(key, revision, value);
      const head = value as { pointer?: { row_id: string } };
      if (!heldWinner && result && key.includes("/head/") && head.pointer?.row_id === "winner") {
        heldWinner = true; winnerCommitted.resolve(); await acknowledgeWinner.promise;
      }
      return result;
    });
    const old = coordinator.execute(request(), async () => { pauseOldRead = true; return skill(2, "late"); });
    await oldReadStarted.promise;
    now = 1200;
    const winner = coordinator.execute(request(), async () => skill(2, "winner"));
    await winnerCommitted.promise;
    resumeOldRead.resolve();
    try {
      expect(await old).toMatchObject({ row_id: "winner" });
    } finally {
      acknowledgeWinner.resolve();
      await winner;
    }
    expect(await coordinator.lookup(scope, "update-a")).toMatchObject({ status: "committed", skill: { row_id: "winner" } });
  });

  it("never commits a malformed or wrong-scope candidate", async () => {
    const { coordinator } = fixture();
    await expect(coordinator.execute(request(), async () => skill(2, "row-2", { team_id: "other" })))
      .rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    expect(await coordinator.getHead(scope)).toMatchObject({ version: 1 });
  });

  it("isolates namespaces even for identical skill and mutation IDs", async () => {
    const { coordinator, store } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const other = new PersistentSkillPublicationCoordinator({ store, namespace: "instance-b", heartbeat: false });
    expect(await other.getHead(scope)).toBeUndefined();
    expect(await other.lookup(scope, "update-a")).toEqual({ status: "absent" });
  });

  it("serializes the name domain across different new skill IDs", async () => {
    const { coordinator } = fixture();
    const entered = deferred<void>();
    const prepared = deferred<Skill>();
    const pending = coordinator.execute(request("create", 0), async () => { entered.resolve(); return prepared.promise; });
    await entered.promise;
    await expect(coordinator.execute({ ...request("other-create", 0), scope: { ...scope, skill_id: "skl-other" } },
      async () => skill(1, "other", { skill_id: "skl-other" }))).rejects.toMatchObject({ code: "SKILL_NAME_DUPLICATE" });
    prepared.resolve(skill(1));
    await pending;
  });

  it("archives without losing the historical pointer and tombstones before physical removal", async () => {
    const { coordinator } = fixture();
    await coordinator.execute(request(), async () => skill(2));
    const pointer = (await coordinator.getHead(scope))!;
    await coordinator.archive(scope, pointer, async () => {});
    expect(await coordinator.getHead(scope)).toMatchObject({ version: 2, status: "archived" });
    const deleted = await coordinator.remove(scope, pointer, async () => {
      expect(await coordinator.getHead(scope)).toBeNull();
      return 2;
    });
    expect(deleted).toBe(2);
    expect(await coordinator.getHead(scope)).toBeNull();
    await expect(coordinator.execute(request("revive", 0), async () => skill(1))).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });
});
