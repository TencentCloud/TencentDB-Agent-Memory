import { describe, expect, it } from "vitest";
import { MongoSkillStore } from "../../store/mongodb/skill-store.js";
import { TcvdbSkillStore } from "../../store/tcvdb/skill-store.js";
import {
  SkillStoreError, projectPublishedCandidates,
  type ISkillStore, type SkillPublicationCoordinator, type SkillPublicationLookup, type SkillPublicationPointer, type SkillPublicationRequest, type SkillPublicationScope,
  type SkillDeletionReceipt, type SkillDeletionRequest, type SkillDeletionTarget, type SkillDeletionGuard, type SkillDeletionResult,
} from "../skill-store.interface.js";
import type { AppendVersionInput, Skill } from "../types.js";

// Only a test authority. Production lease/fence/receipt persistence is supplied
// by the external coordinator, not by these in-memory backend contracts.
class Authority implements SkillPublicationCoordinator {
  head: SkillPublicationPointer | null | undefined;
  receipts = new Map<string, SkillPublicationLookup>();
  failAfterPrepare = false;
  async execute(req: SkillPublicationRequest, prepare: () => Promise<Skill>): Promise<Skill> {
    const existing = this.receipts.get(req.mutation_id);
    if (existing?.status === "committed") {
      if (existing.payload_hash !== req.payload_hash) throw new SkillStoreError("SKILL_MUTATION_CONFLICT");
      return existing.skill;
    }
    if (existing?.status === "unknown") throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN");
    const version = this.head?.version ?? req.previous_head?.version ?? 0;
    if (req.expected_version !== undefined && req.expected_version !== version) throw new SkillStoreError("SKILL_VERSION_STALE");
    this.head ??= req.previous_head ? { row_id: req.previous_head.row_id, version: req.previous_head.version, mutation_id: req.previous_head.mutation_id ?? "legacy" } : null;
    this.receipts.set(req.mutation_id, { status: "unknown" });
    const skill = await prepare();
    if (this.failAfterPrepare) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN");
    this.head = { row_id: skill.row_id, version: skill.version, mutation_id: req.mutation_id };
    this.receipts.set(req.mutation_id, { status: "committed", skill, payload_hash: req.payload_hash });
    return skill;
  }
  async lookup(_scope: SkillPublicationScope, id: string): Promise<SkillPublicationLookup> { return this.receipts.get(id) ?? { status: "absent" }; }
  async getHead(): Promise<SkillPublicationPointer | null | undefined> { return this.head; }
  deletion: SkillDeletionReceipt | null = null;
  async getDeletionReceipt(): Promise<SkillDeletionReceipt | null> { return this.deletion; }
  async deleteWithReceipt(request: SkillDeletionRequest, prepare: (guard: SkillDeletionGuard) => Promise<SkillDeletionTarget[]>,
    cleanup: (receipt: SkillDeletionReceipt, guard: SkillDeletionGuard) => Promise<number>, options?: { complete?: boolean }): Promise<SkillDeletionResult> {
    const guard = async () => {};
    if (!this.deletion) {
      const targets = await prepare(guard);
      this.deletion = { deletion_id: "test-delete", scope: request.scope, owner_agent_id: request.owner_agent_id,
        name: request.previous_head?.name ?? "skill", original_head: request.expected_head, phase: "pending", targets, created_at_ms: 1 };
      this.head = null;
    }
    if (this.deletion.phase === "complete") return { receipt: this.deletion, completed_now: false, deleted_rows: 0 };
    const deleted = await cleanup(this.deletion, guard);
    if (options?.complete !== false) this.deletion.phase = "complete";
    return { receipt: this.deletion, completed_now: options?.complete !== false, deleted_rows: deleted };
  }
  async remove(_scope: SkillPublicationScope, _expected: SkillPublicationPointer | null, removeRows: () => Promise<number>): Promise<number> {
    this.head = null;
    return removeRows();
  }
  async archive(_scope: SkillPublicationScope, expected: SkillPublicationPointer, archiveRows: () => Promise<void>): Promise<void> {
    this.head = { ...expected, status: "archived" };
    await archiveRows();
  }
}

type Doc = Record<string, unknown>;
function matches(doc: Doc, q: Doc): boolean {
  return Object.entries(q).every(([k, value]) => {
    if (value && typeof value === "object" && "$lte" in value) return Number(doc[k]) <= Number((value as { $lte: number }).$lte);
    if (value && typeof value === "object" && "$ne" in value) return doc[k] !== (value as { $ne: unknown }).$ne;
    if (value && typeof value === "object" && "$in" in value) return (value as { $in: unknown[] }).$in.includes(doc[k]);
    if (value && typeof value === "object" && "$regex" in value) return new RegExp(String((value as { $regex: unknown }).$regex)).test(String(doc[k]));
    return doc[k] === value;
  });
}
function vdbMatches(doc: Doc, filter?: string): boolean {
  if (!filter) return true;
  return [...filter.matchAll(/(\w+)\s*(<=|=)\s*("(?:[^"\\]|\\.)*"|\d+)/g)].every(m => m[2] === "<=" ? Number(doc[m[1]]) <= Number(m[3]) : doc[m[1]] === JSON.parse(m[3]));
}
function harness(backend: "mongo" | "tcvdb", authority?: Authority, opts: { failHintUpdates?: boolean } = {}) {
  const docs: Doc[] = [];
  const stats = { fullDocumentsRead: 0, lightDocumentsRead: 0 };
  let seq = 0;
  const cursor = (q: Doc, projection?: Doc) => {
    let rows = docs.filter(d => matches(d, q));
    return { sort(order: Doc) { const [key, direction] = Object.entries(order)[0]; rows.sort((a,b) => (Number(a[key]) - Number(b[key])) * Number(direction)); return this; }, skip(n: number) { rows = rows.slice(n); return this; }, limit(n: number) { rows = rows.slice(0,n); return this; }, async next() { return rows[0] ?? null; }, async toArray() {
      if (projection && !projection.content) {
        stats.lightDocumentsRead += rows.length;
        return rows.map(row => Object.fromEntries(Object.keys(projection).filter(k => projection[k] && row[k] !== undefined).map(k => [k, row[k]])));
      }
      stats.fullDocumentsRead += rows.length;
      return rows;
    } };
  };
  let store: ISkillStore;
  if (backend === "mongo") {
    const coll = {
      find: (q: Doc, options?: { projection?: Doc }) => cursor(q, options?.projection), findOne: async (q: Doc) => docs.find(d => matches(d,q)) ?? null,
      insertOne: async (doc: Doc) => { docs.push(structuredClone(doc)); return { acknowledged: true }; },
      updateOne: async (q: Doc, update: { $set: Doc }) => { const doc = docs.find(d => matches(d,q)); if (doc) Object.assign(doc, update.$set); return { matchedCount: doc ? 1 : 0 }; },
      deleteMany: async (q: Doc) => { const kept = docs.filter(d => !matches(d,q)); const deletedCount = docs.length - kept.length; docs.splice(0, docs.length, ...kept); return { deletedCount }; },
      deleteOne: async (q: Doc) => { const index = docs.findIndex(d => matches(d,q)); if (index < 0) return { deletedCount: 0 }; docs.splice(index,1); return { deletedCount: 1 }; },
      updateMany: async (q: Doc, update: { $set: Doc }) => {
        if (opts.failHintUpdates) throw new Error("index hint update unavailable");
        const rows = docs.filter(d => matches(d,q)); rows.forEach(row => Object.assign(row, update.$set)); return { matchedCount: rows.length };
      },
      countDocuments: async (q: Doc) => docs.filter(d => matches(d,q)).length,
      aggregate: (pipeline: Doc[]) => ({ toArray: async () => docs.slice(0, Number(pipeline.find(stage => stage.$limit)?.$limit ?? docs.length)) }),
    };
    const mongo = new MongoSkillStore({ pool: {} as never, mongoConfig: {} as never, ulid: () => `row-${++seq}`, publicationCoordinator: authority });
    Object.assign(mongo, { initialized: true, searchIndexReady: true, db: { collection: () => coll } }); store = mongo;
  } else {
    const vdb = new TcvdbSkillStore({ url: "http://localhost", username: "u", apiKey: "test", database: "db", timeout: 1000, embeddingModel: "test", ulid: () => `row-${++seq}`, publicationCoordinator: authority });
    Object.assign(vdb, { initialized: true, client: {
      query: async (_collection: string, q: { filter?: string; documentIds?: string[]; offset?: number; limit?: number; outputFields?: string[]; sort?: Array<{ fieldName: string; direction: string }> }) => {
        let rows = docs.filter(d => q.documentIds ? q.documentIds.includes(String(d.id)) : vdbMatches(d,q.filter));
        const order = q.sort?.[0]; if (order) rows.sort((a,b) => (Number(a[order.fieldName]) - Number(b[order.fieldName])) * (order.direction === "desc" ? -1 : 1));
        rows = rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 1000));
        if (q.outputFields && !q.outputFields.includes("content")) {
          stats.lightDocumentsRead += rows.length;
          return { documents: rows.map(row => Object.fromEntries(q.outputFields!.filter(k => row[k] !== undefined).map(k => [k, row[k]]))) };
        }
        stats.fullDocumentsRead += rows.length;
        return { documents: rows };
      },
      upsert: async (_collection: string, rows: Doc[]) => { for (const row of rows) { const i = docs.findIndex(d => d.id === row.id); if (i < 0) docs.push(structuredClone(row)); else docs[i] = structuredClone(row); } },
      search: async (_collection: string, q: { limit: number }) => ({ documents: [docs.slice(0, q.limit)] }),
      update: async (_collection: string, q: { documentIds?: string[]; update: Doc }) => {
        if (!q.documentIds || opts.failHintUpdates) throw new Error("index hint update unavailable; unsafe head-flip not supported");
        const rows = docs.filter(d => q.documentIds!.includes(String(d.id))); rows.forEach(row => Object.assign(row,q.update)); return rows.length;
      },
      deleteDoc: async (_collection: string, q: { query: { filter?: string; documentIds?: string[] } }) => {
        const kept = docs.filter(d => !(q.query.documentIds ? q.query.documentIds.includes(String(d.id)) : vdbMatches(d, q.query.filter)));
        const count = docs.length - kept.length; docs.splice(0, docs.length, ...kept); return count;
      },
      count: async (_collection: string, filter: string) => docs.filter(d => vdbMatches(d,filter)).length,
    } }); store = vdb;
  }
  return { store, docs, stats };
}
const input = (over: Partial<AppendVersionInput> = {}): AppendVersionInput => ({
  skill_id: "s", team_id: "t", owner_agent_id: "a", name: "skill", description: "desc", content: "body", content_hash: "hash", manifest: [], storage_dir: "skills/s/attempt-a", mutation_id: "intent", expected_version: 0, ...over,
});

it("bounds legacy coordinator head fallback to 16 concurrent calls without receipt loads", async () => {
  const authority = new Authority();
  let active = 0, maxActive = 0;
  Object.assign(authority, {
    getHead: async (scope: SkillPublicationScope) => {
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); active--;
      return { row_id: scope.skill_id, version: 1, mutation_id: scope.skill_id };
    },
    lookup: async () => { throw new Error("current-only projection must not load a receipt"); },
  });
  const candidates = Array.from({ length: 64 }, (_, i) => ({ row_id: `s-${i}`, skill_id: `s-${i}`, team_id: "t", version: 1,
    mutation_id: `s-${i}`, is_head: true, status: "active" as const }));
  expect(await projectPublishedCandidates(candidates, authority, true)).toHaveLength(64);
  expect(maxActive).toBe(16);
});

it("Mongo initialization only replaces the legacy unique version index", async () => {
  const dropped: string[] = [];
  const coll = {
    listIndexes: () => ({ toArray: async () => [{ name: "skill_id_1_version_1", key: { skill_id: 1, version: 1 } }] }),
    dropIndex: async (name: string) => { dropped.push(name); },
    createIndexes: async () => [],
    listSearchIndexes: () => { throw new Error("search unavailable in contract"); },
    find: () => ({ sort() { return this; }, toArray: async () => [] }),
  };
  const pool = { getDb: async () => ({ collection: () => coll }), getClusterProfile: async () => ({ mongot: true }) };
  const store = new MongoSkillStore({ pool: pool as never, mongoConfig: {} as never, searchIndexWaitMs: 0 });
  store.init();
  await store.getHead("s", "t");
  expect(store.isDegraded()).toBe(false);
  expect(dropped).toEqual([]);
});

for (const backend of ["mongo", "tcvdb"] as const) describe(`${backend} publication contract (fake responses, no cloud)`, () => {
  it("fails closed without an external publication authority", async () => {
    const { store, docs } = harness(backend);
    await expect(store.appendVersion(input())).rejects.toMatchObject({ code: "SKILL_PUBLICATION_COORDINATOR_REQUIRED" });
    expect(docs).toHaveLength(0);
  });
  it("accepts a publication coordinator bound after pool construction", async () => {
    const { store } = harness(backend);
    store.setPublicationCoordinator!(new Authority());
    expect((await store.appendVersion(input())).version).toBe(1);
  });
  it("uses input.storage_dir and verifies mutation replay and payload conflicts", async () => {
    const { store } = harness(backend, new Authority());
    const first = await store.appendVersion(input());
    expect(first.storage_dir).toBe("skills/s/attempt-a");
    expect((await store.appendVersion(input({ storage_dir: "skills/s/another-attempt" }))).row_id).toBe(first.row_id);
    await expect(store.appendVersion(input({ content: "different" }))).rejects.toMatchObject({ code: "SKILL_MUTATION_CONFLICT" });
    await expect(store.appendVersion(input({ mutation_id: "second" }))).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });
  it("publishes through the authoritative pointer without the unsafe remote head flip", async () => {
    const { store } = harness(backend, new Authority());
    const first = await store.appendVersion(input());
    const second = await store.appendVersion(input({ mutation_id: "second", expected_version: 1, content: "v2" }));
    expect(second.version).toBe(2);
    expect((await store.getHead("s", "t"))?.row_id).toBe(second.row_id);
    expect((await store.getByVersion("s", 1, "t"))?.is_head).toBe(false);
    expect((await store.listSkills({ team_id: "t" })).items.map(s => s.row_id)).toEqual([second.row_id]);
    expect((await store.listVersions("s", "t")).map(s => s.row_id)).toEqual([second.row_id, first.row_id]);
  });
  it("unknown prepared candidates remain invisible while the old head remains readable", async () => {
    const authority = new Authority(); const { store, docs } = harness(backend, authority);
    const first = await store.appendVersion(input());
    authority.failAfterPrepare = true;
    await expect(store.appendVersion(input({ mutation_id: "uncertain", expected_version: 1, content: "v2" }))).rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
    expect(docs).toHaveLength(2);
    expect((await store.getHead("s", "t"))?.row_id).toBe(first.row_id);
    expect(await store.getByVersion("s", 2, "t")).toBeNull();
    expect((await store.listVersions("s", "t")).map(s => s.row_id)).toEqual([first.row_id]);
    expect((await store.listSkills({ team_id: "t" })).items.map(s => s.row_id)).toEqual([first.row_id]);
    expect((await store.searchSkills({ team_id: "t", query: "body", mode: "embedding" })).map(hit => hit.skill.row_id)).toEqual([first.row_id]);
    await expect(store.getByMutationId("s", "uncertain", "t")).rejects.toMatchObject({ code: "SKILL_PUBLICATION_UNKNOWN" });
  });
  it("lists one of 5000 heads with light batches and only one full body load", async () => {
    const authority = new Authority();
    const calls = { singleHead: 0, batchHeads: 0, receipts: 0, largestBatch: 0 };
    const pointers = new Map<string, SkillPublicationPointer>();
    Object.assign(authority, {
      getHead: async (scope: SkillPublicationScope) => { calls.singleHead++; return pointers.get(scope.skill_id); },
      getHeads: async (scopes: SkillPublicationScope[]) => {
        calls.batchHeads++; calls.largestBatch = Math.max(calls.largestBatch, scopes.length);
        return scopes.map(scope => pointers.get(scope.skill_id));
      },
      lookup: async (scope: SkillPublicationScope) => {
        calls.receipts++;
        return { status: "committed", skill: { row_id: pointers.get(scope.skill_id)!.row_id } as Skill, payload_hash: "test" };
      },
    });
    const { store, docs, stats } = harness(backend, authority);
    for (let i = 0; i < 5000; i++) {
      pointers.set(`s-${i}`, { row_id: `row-${i}`, version: 1, mutation_id: `mutation-${i}`, status: "active" });
      docs.push({ _id: `row-${i}`, id: `row-${i}`, row_id: `row-${i}`, skill_id: `s-${i}`, team_id: "t", owner_agent_id: "a", version: 1,
        mutation_id: `mutation-${i}`, is_head: backend === "mongo" ? true : 1, status: "active", name: `skill-${i}`,
        updated_at_ms: i, created_at_ms: i, content: "x".repeat(4096), manifest_json: "[]" });
    }
    const result = await store.listSkills({ team_id: "t", limit: 1 });
    expect(result.total).toBe(5000);
    expect(result.items.map(row => row.row_id)).toEqual(["row-4999"]);
    expect(stats.fullDocumentsRead).toBe(1);
    expect(stats.lightDocumentsRead).toBe(5000);
    expect(calls.singleHead).toBe(0);
    expect(calls.receipts).toBe(0);
    expect(calls.batchHeads).toBeLessThanOrEqual(20);
    expect(calls.largestBatch).toBeLessThanOrEqual(256);
  });
  it("loads only the requested version page instead of all historical bodies and receipts", async () => {
    const authority = new Authority();
    authority.head = { row_id: "row-4999", version: 5000, mutation_id: "mutation-4999", status: "active" };
    let receipts = 0;
    Object.assign(authority, { lookup: async (_scope: SkillPublicationScope, id: string) => {
      receipts++;
      return { status: "committed", skill: { row_id: id.replace("mutation-", "row-") } as Skill, payload_hash: "test" };
    } });
    const { store, docs, stats } = harness(backend, authority);
    for (let i = 0; i < 5000; i++) docs.push({ _id: `row-${i}`, id: `row-${i}`, row_id: `row-${i}`, skill_id: "s", team_id: "t", version: i + 1,
      mutation_id: `mutation-${i}`, is_head: backend === "mongo" ? i === 4999 : Number(i === 4999), status: "active",
      created_at_ms: i, updated_at_ms: i, content: "x".repeat(4096), manifest_json: "[]" });
    expect((await store.listVersions("s", "t", { limit: 1 })).map(row => row.row_id)).toEqual(["row-4999"]);
    expect(stats.fullDocumentsRead).toBe(1);
    expect(stats.lightDocumentsRead).toBeLessThanOrEqual(256);
    expect(receipts).toBe(0);
    expect(await store.countVersions("s", "t")).toBe(5000);
    expect(stats.fullDocumentsRead).toBe(1);
  });
  it("maintains bounded non-authoritative head hints without touching a later candidate", async () => {
    const { store, docs } = harness(backend, new Authority());
    const first = await store.appendVersion(input());
    docs.push({ ...docs[0], _id: "future", id: "future", row_id: "future", version: 99, mutation_id: "future" });
    const current = await store.appendVersion(input({ expected_version: 1, mutation_id: "current", content: "v2" }));
    const old = docs.find(doc => (doc.id ?? doc.row_id) === first.row_id)!;
    expect(old.is_head).toBe(backend === "mongo" ? false : 0);
    expect(docs.find(doc => (doc.id ?? doc.row_id) === "future")?.is_head).toBe(backend === "mongo" ? true : 1);
    expect((await store.getHead("s", "t"))?.row_id).toBe(current.row_id);
  });
  it("overfetches past many old or uncommitted ranked candidates to find the published head", async () => {
    const { store, docs } = harness(backend, new Authority(), { failHintUpdates: true });
    await store.appendVersion(input());
    for (let i = 0; i < 100; i++) docs.push({ ...docs[0], _id: `orphan-${i}`, id: `orphan-${i}`, row_id: `orphan-${i}`, mutation_id: `uncommitted-${i}` });
    const current = await store.appendVersion(input({ expected_version: 1, mutation_id: "current", content: "body newest" }));
    const hits = await store.searchSkills({ team_id: "t", query: "body", mode: "embedding", topK: 1 });
    expect(hits.map(hit => hit.skill.row_id)).toEqual([current.row_id]);
  });
  it("archive uses pointer status even if physical status is overwritten later", async () => {
    const authority = new Authority(); const { store, docs } = harness(backend, authority);
    await store.appendVersion(input());
    expect(await store.archiveHead("s", "t")).toEqual({ archived: true });
    for (const doc of docs) doc.status = "active";
    expect(authority.head?.status).toBe("archived");
    expect(await store.getHead("s", "t")).toBeNull();
    expect(await store.getHead("s")).toBeNull();
    expect((await store.getHeadIncludingArchived("s", "t"))?.status).toBe("archived");
    expect((await store.listSkills({ team_id: "t" })).items).toEqual([]);
    expect(await store.searchSkills({ team_id: "t", query: "body", mode: "embedding" })).toEqual([]);
  });
  it("does not reserve a name when authority archived its still-active physical row", async () => {
    const authority = new Authority(); const { store, docs } = harness(backend, authority);
    await store.appendVersion(input());
    await store.archiveHead("s", "t");
    expect(docs[0].status).toBe("active");
    // Unit boundary: name-domain atomic reservation belongs to the authority;
    // this verifies the backend's published-name precheck does not reject it.
    if (backend === "mongo") {
      const subject = store as unknown as {
        coll(): Promise<unknown>;
        _assertNameUnique(coll: unknown, name: string, team: string, owner: string, excluded: string): Promise<void>;
      };
      await expect(subject._assertNameUnique(await subject.coll(), "skill", "t", "a", "other-skill")).resolves.toBeUndefined();
    } else {
      const subject = store as unknown as {
        _assertNameUnique(name: string, team: string, owner: string, excluded: string): Promise<void>;
      };
      await expect(subject._assertNameUnique("skill", "t", "a", "other-skill")).resolves.toBeUndefined();
    }
  });
  it("delete tombstones visibility before cleanup and late candidates cannot revive it", async () => {
    const authority = new Authority(); const { store, docs } = harness(backend, authority);
    await store.appendVersion(input({ storage_dir: "skills/s/v1/attempts/delete-test" }));
    const late = { ...docs[0] };
    expect(await store.deleteAllVersions("s", "t")).toBe(1);
    expect(authority.head).toBeNull();
    docs.push(late);
    expect(await store.getHead("s", "t")).toBeNull();
    expect(await store.getByVersion("s", 1, "t")).toBeNull();
    expect(await store.listVersions("s", "t")).toEqual([]);
    expect((await store.listSkills({ team_id: "t" })).items).toEqual([]);
  });
  it("historical deletion honors the authority rather than stale physical head flags", async () => {
    const { store } = harness(backend, new Authority());
    await store.appendVersion(input());
    await store.appendVersion(input({ expected_version: 1, mutation_id: "next", content: "v2" }));
    expect(await store.deleteVersion("s", 2)).toBe(false);
    expect(await store.deleteVersion("s", 1)).toBe(true);
    expect((await store.getHead("s", "t"))?.version).toBe(2);
  });
  it("filters losing attempts even when they share a committed mutation id", async () => {
    const authority = new Authority(); const { store, docs } = harness(backend, authority);
    const first = await store.appendVersion(input());
    docs.push({ ...docs[0], _id: "late", id: "late", row_id: "late", storage_dir: "skills/s/late" });
    expect((await store.listVersions("s", "t")).map(s => s.row_id)).toEqual([first.row_id]);
    expect((await store.listSkills({ team_id: "t" })).items.map(s => s.row_id)).toEqual([first.row_id]);
  });
});
