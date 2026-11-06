import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillCore } from "./skill-core.js";
import { SkillVersioning } from "./skill-versioning.js";
import { SkillResourceStore } from "./skill-resource-store.js";
import { PersistentSkillPublicationCoordinator } from "./skill-publication-coordinator.js";
import { SqliteSkillStateStore } from "./skill-state-store.js";
import { SqliteSkillStore } from "../store/sqlite/skill-store.js";
import { MongoSkillStore } from "../store/mongodb/skill-store.js";
import { TcvdbSkillStore } from "../store/tcvdb/skill-store.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import type { Skill } from "./types.js";
import type { ISkillStore } from "./skill-store.interface.js";

type Doc = Record<string, unknown>;
const actor = { user_id: "user", team_id: "team", agent_id: "owner" };
const scope = { team_id: actor.team_id, skill_id: "skl-delete" };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function matches(row: Doc, query: Doc) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object") {
      if ("$in" in value) return (value as { $in: unknown[] }).$in.includes(row[key]);
      if ("$ne" in value) return row[key] !== (value as { $ne: unknown }).$ne;
      if ("$lte" in value) return Number(row[key]) <= Number((value as { $lte: number }).$lte);
    }
    return row[key] === value;
  });
}
function filterMatches(row: Doc, filter = "") {
  return [...filter.matchAll(/(\w+)\s*(<=|=)\s*("(?:[^"\\]|\\.)*"|\d+)/g)]
    .every(match => match[2] === "<=" ? Number(row[match[1]]) <= Number(match[3]) : row[match[1]] === JSON.parse(match[3]));
}
async function fixture(backend: "mongo" | "tcvdb", legacy = false, versions = 1) {
  const root = await mkdtemp(join(tmpdir(), "skill-delete-recovery-"));
  const db = new DatabaseSync(":memory:");
  const state = new SqliteSkillStateStore(db); await state.init();
  const coordinator = new PersistentSkillPublicationCoordinator({ store: state, namespace: "delete-instance", heartbeat: false, leaseMs: 10_000 });
  const storage = new StorageAdapter(new LocalStorageBackend(root));
  const resources = new SkillResourceStore({ storage });
  const docs: Doc[] = [];
  const faults = { deleteBefore: 0, deleteAfter: 0, hook: 0 };
  const deleteRows = vi.fn(async (predicate: (doc: Doc) => boolean) => {
    if (faults.deleteBefore > 0) { faults.deleteBefore--; throw new Error("remote delete failed"); }
    const remaining = docs.filter(doc => !predicate(doc));
    const count = docs.length - remaining.length; docs.splice(0, docs.length, ...remaining);
    if (faults.deleteAfter > 0) { faults.deleteAfter--; throw new Error("delete acknowledgement lost"); }
    return count;
  });
  let store: ISkillStore;
  if (backend === "mongo") {
    const coll = {
      findOne: async (q: Doc) => docs.find(doc => matches(doc, q)) ?? null,
      find(q: Doc, options?: { projection?: Doc }) {
        let rows = docs.filter(doc => matches(doc, q));
        return {
          sort(order: Doc) { const [key, direction] = Object.entries(order)[0]; rows.sort((a,b) => (Number(a[key]) - Number(b[key])) * Number(direction)); return this; },
          skip(n: number) { rows = rows.slice(n); return this; }, limit(n: number) { rows = rows.slice(0,n); return this; },
          async toArray() { return options?.projection ? rows.map(row => Object.fromEntries(Object.keys(options.projection!).filter(k => options.projection![k] && row[k] !== undefined).map(k => [k,row[k]]))) : rows; },
        };
      },
      deleteMany: async (q: Doc) => ({ deletedCount: await deleteRows(doc => matches(doc, q)) }),
    };
    store = new MongoSkillStore({ pool: {} as never, mongoConfig: {} as never, publicationCoordinator: coordinator });
    Object.assign(store, { initialized: true, db: { collection: () => coll } });
  } else {
    store = new TcvdbSkillStore({ url: "http://localhost", username: "test", apiKey: "test", database: "db", timeout: 1000,
      embeddingModel: "test", publicationCoordinator: coordinator });
    Object.assign(store, { initialized: true, client: {
      query: async (_collection: string, q: { filter?: string; documentIds?: string[]; offset?: number; limit?: number; outputFields?: string[]; sort?: Array<{ fieldName: string; direction: string }> }) => {
        let rows = docs.filter(doc => q.documentIds ? q.documentIds.includes(String(doc.id)) : filterMatches(doc, q.filter));
        const sort = q.sort?.[0]; if (sort) rows.sort((a,b) => (Number(a[sort.fieldName]) - Number(b[sort.fieldName])) * (sort.direction === "desc" ? -1 : 1));
        rows = rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 1000));
        return { documents: q.outputFields ? rows.map(row => Object.fromEntries(q.outputFields!.filter(k => row[k] !== undefined).map(k => [k,row[k]]))) : rows };
      },
      deleteDoc: async (_collection: string, request: { query: { documentIds?: string[]; filter?: string } }) => deleteRows(doc =>
        request.query.documentIds ? request.query.documentIds.includes(String(doc.id)) : filterMatches(doc, request.query.filter)),
    } });
  }
  const usage = vi.fn();
  const hook = vi.fn((): Promise<void> => {
    if (faults.hook > 0) {
      faults.hook--;
      const failure = Promise.reject(new Error("asset deletion failed"));
      void failure.catch(() => {}); // baseline fire-and-forget must not cause a test harness unhandled rejection
      return failure;
    }
    return Promise.resolve();
  });
  const versioning = new SkillVersioning({ store, storage, resources, onSkillVdbChanged: usage });
  const core = new SkillCore({ store, resources, versioning, onSkillArchived: hook });
  const rows: Skill[] = [];
  for (let version = 1; version <= versions; version++) {
    const storageDir = `skills/${scope.skill_id}/v${version}/attempts/seed-${version}`;
    const manifest = [await resources.writeResource(scope.skill_id, version, { path: "keep.txt", content: `bytes-${version}`, encoding: "utf-8" }, storageDir)];
    const skill: Skill = { ...scope, row_id: `row-${version}`, version, is_head: true, owner_agent_id: actor.agent_id,
      user_id: actor.user_id, task_id: "task", name: "delete-guide", description: "Delete safely", content: "body", content_hash: "hash",
      manifest, storage_dir: storageDir, status: "active", metadata_json: "{}", created_at_ms: version, updated_at_ms: version,
      ...(legacy ? {} : { mutation_id: `seed-${version}`, mutation_payload_hash: `payload-${version}` }) };
    const prepare = async () => {
      if (legacy) docs.forEach(doc => { doc.is_head = backend === "mongo" ? false : 0; });
      docs.push({ ...skill, _id: skill.row_id, id: skill.row_id, is_head: backend === "mongo" ? true : 1, manifest_json: JSON.stringify(manifest) });
      return skill;
    };
    if (legacy) await prepare();
    else await coordinator.execute({ scope, mutation_id: `seed-${version}`, payload_hash: `payload-${version}`, expected_version: version - 1,
      owner_agent_id: actor.agent_id, name: skill.name }, prepare);
    rows.push(skill);
  }
  closes.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, state, coordinator, storage, resources, versioning, core, store, docs, rows, faults, deleteRows, hook, usage };
}

it("awaits a promise-returning native SQLite hook while retaining legacy best-effort failure semantics", async () => {
  const f = await fixture("mongo", false, 0);
  const native = new SqliteSkillStore({ db: f.db, dimensions: 0 }); native.init();
  await native.appendVersion({ ...scope, owner_agent_id: actor.agent_id, user_id: actor.user_id, name: "native-delete",
    description: "Native delete", content: "body", content_hash: "hash", manifest: [], storage_dir: "" });
  const entered = deferred(); let failHook!: () => void;
  const hookResult = new Promise<void>((_resolve, reject) => { failHook = () => reject(new Error("metadata failure")); });
  void hookResult.catch(() => {});
  const versioning = new SkillVersioning({ store: native, storage: f.storage, resources: f.resources });
  const core = new SkillCore({ store: native, versioning, resources: f.resources, onSkillArchived: () => { entered.resolve(); return hookResult; } });
  let finished = false;
  const deleting = core.delete({ ...actor, skill_id: scope.skill_id }).then(result => { finished = true; return result; });
  await entered.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  try { expect(finished).toBe(false); } finally { failHook(); }
  expect(await deleting).toMatchObject({ archived: true });
  expect(await native.getHead(scope.skill_id, scope.team_id)).toBeNull();
});

for (const backend of ["mongo", "tcvdb"] as const) describe(`${backend} authorized deletion recovery (real SQLite control/local storage, fake remote)`, () => {
  it("resumes row deletion after tombstoning while preserving original-owner authorization", async () => {
    const f = await fixture(backend); f.faults.deleteBefore = 1;
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    expect(await f.coordinator.getHead(scope)).toBeNull();
    expect(f.docs).toHaveLength(1);
    expect(await f.coordinator.getDeletionReceipt(scope)).toMatchObject({ owner_agent_id: actor.agent_id, phase: "pending" });
    await expect(f.core.delete({ ...actor, agent_id: "intruder", skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_NOT_OWNER" });
    await expect(f.core.delete({ ...actor, team_id: "wrong-team", skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(f.deleteRows).toHaveBeenCalledTimes(1);
    expect(await f.core.delete({ ...actor, skill_id: scope.skill_id })).toEqual({ skill_id: scope.skill_id, archived: true });
    expect(f.docs).toEqual([]); expect(await f.storage.readFile(`${f.rows[0].storage_dir}/files/keep.txt`)).toBeNull();
    expect(f.hook).toHaveBeenCalledTimes(1); expect(f.usage.mock.calls).toEqual([[-1]]);
    expect(await f.coordinator.getDeletionReceipt(scope)).toMatchObject({ phase: "complete" });
  });

  it("retries resource cleanup after all remote rows are already gone", async () => {
    const f = await fixture(backend, false, 2);
    const removeDir = f.storage.rmdir.bind(f.storage); let fail = true;
    vi.spyOn(f.storage, "rmdir").mockImplementation(async dir => { if (fail) { fail = false; throw new Error("resource cleanup failed"); } return removeDir(dir); });
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    expect(f.docs).toEqual([]); expect(f.hook).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
    await expect(f.core.delete({ ...actor, agent_id: "intruder", skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_NOT_OWNER" });
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    for (const row of f.rows) expect(await f.storage.readFile(`${row.storage_dir}/files/keep.txt`)).toBeNull();
    expect(f.usage.mock.calls).toEqual([[-2]]);
  });

  it("awaits required deletion hooks and reports usage only on first completed cleanup", async () => {
    const f = await fixture(backend); f.faults.hook = 1;
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    expect(f.docs).toEqual([]); expect(await f.storage.readFile(`${f.rows[0].storage_dir}/files/keep.txt`)).toBeNull();
    expect(f.usage).not.toHaveBeenCalled();
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    expect(f.hook).toHaveBeenCalledTimes(2); expect(f.usage.mock.calls).toEqual([[-1]]);
    await expect(f.coordinator.execute({ scope, mutation_id: "revive", payload_hash: "x", expected_version: 0, name: "delete-guide", owner_agent_id: actor.agent_id }, async () => f.rows[0]))
      .rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
  });

  it("recovers an unknown remote-delete acknowledgement without losing resource targets", async () => {
    const f = await fixture(backend); f.faults.deleteAfter = 1;
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    expect(f.docs).toEqual([]);
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    expect(await f.storage.readFile(`${f.rows[0].storage_dir}/files/keep.txt`)).toBeNull();
    expect(f.usage.mock.calls).toEqual([[-1]]);
  });

  it("records real legacy owner identity before tombstone so cleanup can be authorized after restart", async () => {
    const f = await fixture(backend, true); f.faults.deleteBefore = 1;
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    const restarted = new PersistentSkillPublicationCoordinator({ store: f.state, namespace: "delete-instance", heartbeat: false });
    expect(await restarted.getDeletionReceipt(scope)).toMatchObject({ owner_agent_id: "owner", name: "delete-guide", phase: "pending" });
    f.store.setPublicationCoordinator?.(restarted);
    await expect(f.core.delete({ ...actor, agent_id: "intruder", skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_NOT_OWNER" });
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    expect(f.docs).toEqual([]);
  });

  it("deletes only frozen authorized rows and never purges another owner's uncommitted candidate", async () => {
    const f = await fixture(backend);
    const foreignDir = `skills/${scope.skill_id}/v2/attempts/foreign`;
    await f.resources.writeResource(scope.skill_id, 2, { path: "private", content: "keep foreign bytes", encoding: "utf-8" }, foreignDir);
    f.docs.push({ ...f.docs[0], _id: "foreign", id: "foreign", row_id: "foreign", version: 2, owner_agent_id: "other-owner", mutation_id: "uncommitted", storage_dir: foreignDir });
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    expect(f.docs.map(doc => doc.row_id)).toEqual(["foreign"]);
    expect(await f.storage.readFile(`${foreignDir}/files/private`)).toBe("keep foreign bytes");
    expect(await f.store.getHead(scope.skill_id, scope.team_id)).toBeNull();
  });

  it("serializes concurrent cleanup attempts instead of duplicating required hooks", async () => {
    const f = await fixture(backend); const entered = deferred(), release = deferred();
    const removeDir = f.storage.rmdir.bind(f.storage);
    vi.spyOn(f.storage, "rmdir").mockImplementation(async dir => { entered.resolve(); await release.promise; await removeDir(dir); });
    const first = f.core.delete({ ...actor, skill_id: scope.skill_id });
    await entered.promise;
    try {
      await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_PUBLICATION_BUSY" });
    } finally { release.resolve(); await first; }
    expect(f.hook).toHaveBeenCalledTimes(1); expect(f.usage.mock.calls).toEqual([[-1]]);
  });

  it("rejects unsafe version directories before tombstoning or touching storage", async () => {
    const f = await fixture(backend, true);
    f.docs[0].storage_dir = "skills";
    const remove = vi.spyOn(f.storage, "rmdir");
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(f.docs).toHaveLength(1); expect(remove).not.toHaveBeenCalled();
    expect(await f.store.getHead(scope.skill_id, scope.team_id)).not.toBeNull();
  });

  it("preserves instance-admin omitted-identity semantics across a resource-cleanup retry", async () => {
    const f = await fixture(backend);
    const remove = f.storage.rmdir.bind(f.storage); let fail = true;
    vi.spyOn(f.storage, "rmdir").mockImplementation(async dir => { if (fail) { fail = false; throw new Error("storage unavailable"); } return remove(dir); });
    await expect(f.core.delete({ skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    expect(f.docs).toEqual([]);
    await expect(f.core.delete({ skill_id: scope.skill_id, agent_id: "intruder" })).rejects.toMatchObject({ code: "SKILL_NOT_OWNER" });
    expect(await f.core.delete({ skill_id: scope.skill_id })).toEqual({ skill_id: scope.skill_id, archived: true });
    expect(f.hook).toHaveBeenCalledWith({ skill_id: scope.skill_id, team_id: scope.team_id });
    expect(f.usage.mock.calls).toEqual([[-1]]);
  });

  it("validates cleanup against the configured resource version root on initial deletion and retry", async () => {
    const f = await fixture(backend, true);
    const oldDirectory = f.rows[0].storage_dir;
    const directory = `custom-resource-root/${scope.skill_id}/v1/attempts/custom`;
    await f.storage.writeFile(`${directory}/files/keep.txt`, "bytes-1");
    await f.storage.rmdir(oldDirectory);
    f.docs[0].storage_dir = directory;
    vi.spyOn(f.resources, "versionDir").mockImplementation((id, version) => `custom-resource-root/${id}/v${version}`);
    f.faults.deleteBefore = 1;
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    expect(await f.storage.readFile(`${directory}/files/keep.txt`)).toBeNull();
  });

  it("rejects oversized history without truncating targets or committing a tombstone", async () => {
    const f = await fixture(backend, true);
    const versions = Array.from({ length: 4097 }, (_, index) => ({ ...f.rows[0], row_id: `limit-${index}`, version: index + 1,
      storage_dir: `skills/${scope.skill_id}/v${index + 1}/attempts/limit`, manifest: [] }));
    vi.spyOn(f.store, "listVersions").mockImplementation(async (_id, _team, pagination) => versions.slice(pagination?.offset ?? 0, (pagination?.offset ?? 0) + (pagination?.limit ?? 50)));
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    expect(f.deleteRows).not.toHaveBeenCalled(); expect(f.docs).toHaveLength(1);
    expect(await f.store.getHead(scope.skill_id, scope.team_id)).not.toBeNull();
    expect(await f.coordinator.getDeletionReceipt(scope)).toBeNull();
  });

  it("rejects an oversized receipt before data deletion rather than dropping directory targets", async () => {
    const f = await fixture(backend, true);
    f.docs[0].storage_dir = `skills/${scope.skill_id}/v1/attempts/${"x".repeat(900_000)}`;
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    expect(f.deleteRows).not.toHaveBeenCalled(); expect(f.docs).toHaveLength(1);
    expect(await f.coordinator.getDeletionReceipt(scope)).toBeNull();
  });

  for (const stage of ["tombstone", "complete"] as const) it(`recovers a lost ${stage} acknowledgement using the persisted deletion receipt`, async () => {
    const f = await fixture(backend); const compare = f.state.compareAndSet.bind(f.state); let fault = true;
    vi.spyOn(f.state, "compareAndSet").mockImplementation(async (key, revision, value) => {
      const done = await compare(key, revision, value);
      const record = value as { kind?: string; deleted?: boolean; phase?: string };
      if (fault && done && (stage === "tombstone" ? record.kind === "head" && record.deleted === true : record.kind === "deletion" && record.phase === "complete")) {
        fault = false; throw new Error("metadata acknowledgement lost");
      }
      return done;
    });
    if (stage === "tombstone") await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_DELETION_PENDING" });
    else expect(await f.core.delete({ ...actor, skill_id: scope.skill_id })).toMatchObject({ archived: true });
    await f.core.delete({ ...actor, skill_id: scope.skill_id });
    expect(f.docs).toEqual([]); expect(f.hook).toHaveBeenCalledTimes(1); expect(f.usage.mock.calls).toEqual([[-1]]);
    expect(await f.coordinator.getDeletionReceipt(scope)).toMatchObject({ phase: "complete" });
  });

  it("fences an expired cleanup before its late continuation can repeat the required hook", async () => {
    const f = await fixture(backend); let now = 100;
    f.store.setPublicationCoordinator?.(new PersistentSkillPublicationCoordinator({ store: f.state, namespace: "delete-instance", heartbeat: false, leaseMs: 100, now: () => now }));
    const entered = deferred(), release = deferred(); const remove = f.storage.rmdir.bind(f.storage); let first = true;
    vi.spyOn(f.storage, "rmdir").mockImplementation(async dir => { if (first) { first = false; entered.resolve(); await release.promise; } await remove(dir); });
    const old = f.core.delete({ ...actor, skill_id: scope.skill_id });
    await entered.promise;
    try {
      now = 300;
      await f.core.delete({ ...actor, skill_id: scope.skill_id });
    } finally { release.resolve(); await old; }
    expect(f.hook).toHaveBeenCalledTimes(1); expect(f.usage.mock.calls).toEqual([[-1]]);
  });

  it("does not interpret unpublished null heads as deletion authority or cross namespaces", async () => {
    const f = await fixture(backend, false, 0);
    await expect(f.coordinator.execute({ scope, mutation_id: "failed-create", payload_hash: "hash", expected_version: 0, name: "guide", owner_agent_id: "other-owner" }, async () => { throw new Error("preparation failed"); })).rejects.toThrow();
    expect(await f.coordinator.getHead(scope)).toBeNull();
    expect(await f.coordinator.getDeletionReceipt(scope)).toBeNull();
    await expect(f.core.delete({ ...actor, skill_id: scope.skill_id })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(f.deleteRows).not.toHaveBeenCalled();
    const other = new PersistentSkillPublicationCoordinator({ store: f.state, namespace: "other-instance", heartbeat: false });
    expect(await other.getDeletionReceipt(scope)).toBeNull();
  });
});
