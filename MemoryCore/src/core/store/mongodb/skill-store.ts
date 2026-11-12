/**
 * MongoSkillStore — MongoDB (mongot `$search` BM25) backend for `ISkillStore`
 * (phase-1). Stores skill **version rows** with inline `SKILL.md` content and
 * `manifest_json` metadata (T10 content boundary): resource file *bytes* under
 * `files/` stay in the storage backend (COS/local) and are out of scope here.
 *
 * CRUD/version logic uses ordinary strongly-consistent finds; only
 * `searchSkills` uses the eventually-consistent `$search` (mongot) BM25 path.
 * Capabilities are derived from runtime state (D9); errors on the version path
 * surface (fail-loud, D13). Keyword-only: no dense vectors.
 */

import { randomUUID } from "node:crypto";
import type { Collection, Db, Document } from "mongodb";
import type { MongoConfig } from "../../instance-config-provider.js";
import type { MongoClientPool } from "./client-pool.js";
import type { StoreLogger } from "../types.js";
import type {
  ISkillStore,
  SkillPublicationCoordinator,
  SkillPublicationCandidate,
  SkillDeletionRequest,
  SkillDeletionReceipt,
  SkillDeletionResult,
  SkillDeletionCleanup,
  SkillStoreCapabilities,
  SkillSearchResult,
  ExpiredVersionMeta,
} from "../../skill/skill-store.interface.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillManifestEntry,
  SkillStatus,
} from "../../skill/types.js";
import { SkillStoreError, assertSkillExpectedVersion, assertSkillMutationMatch, skillPayloadHash, projectPublishedCandidates, lookupSkillMutation, collectSkillDeletionTargets } from "../../skill/skill-store.interface.js";
import { randomBase62 } from "../../../utils/short-id.js";
import { tokenizeForFts, mongoSearchScoreToScore } from "../tokenize.js";
import { COLLECTIONS } from "./collections.js";
import {
  SKILL_SEARCH_INDEX,
  SKILL_SEARCH_DEFINITION,
  ensureSearchIndex,
} from "./search-index.js";

const TAG = "[mongo-skill-store]";
const PUBLICATION_LIST_PROJECTION = {
  _id: 1, row_id: 1, skill_id: 1, team_id: 1, version: 1, is_head: 1, status: 1, mutation_id: 1,
};

export interface MongoSkillStoreConfig {
  pool: MongoClientPool;
  mongoConfig: MongoConfig;
  logger?: StoreLogger;
  ulid?: () => string;
  now?: () => number;
  searchIndexWaitMs?: number;
  publicationCoordinator?: SkillPublicationCoordinator;
}

function defaultUlid(): string {
  return randomBase62(12);
}

export class MongoSkillStore implements ISkillStore {
  private publicationCoordinator?: SkillPublicationCoordinator;
  private readonly pool: MongoClientPool;
  private readonly mongoConfig: MongoConfig;
  private readonly logger?: StoreLogger;
  private readonly ulid: () => string;
  private readonly now: () => number;
  private readonly searchIndexWaitMs: number;

  private db: Db | null = null;
  private initPromise?: Promise<void>;
  private initialized = false;
  private degraded = false;
  private searchIndexReady = false;

  constructor(config: MongoSkillStoreConfig) {
    this.publicationCoordinator = config.publicationCoordinator;
    this.pool = config.pool;
    this.mongoConfig = config.mongoConfig;
    this.logger = config.logger;
    this.ulid = config.ulid ?? defaultUlid;
    this.now = config.now ?? (() => Date.now());
    this.searchIndexWaitMs = config.searchIndexWaitMs ?? 60_000;
  }

  setPublicationCoordinator(coordinator: SkillPublicationCoordinator): void {
    this.publicationCoordinator = coordinator;
  }

  // ── Lifecycle ───────────────────────────────────────────

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.initPromise = this._initAsync().catch((err) => {
      this.logger?.error(`${TAG} Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    });
  }

  private async _initAsync(): Promise<void> {
    const db = await this.pool.getDb(this.mongoConfig);
    // Same gate as MongoMemoryStore: no mongot → keyword search impossible.
    // Throwing here lands in init()'s catch → degraded=true with a clear log.
    const profile = await this.pool.getClusterProfile(this.mongoConfig);
    if (!profile.mongot) {
      throw new Error(
        `${TAG} mongot ($search) unavailable: probed topology=${profile.topology} ` +
          `version=${profile.version || "?"} — skill keyword search requires mongot.`,
      );
    }
    const coll = db.collection(COLLECTIONS.SKILLS);
    // Multiple immutable attempts may target one version. Authority selects
    // exactly one; the old version-unique index would block crash recovery.
    try {
      for (const index of await coll.listIndexes().toArray()) {
        if (index.unique && index.key?.skill_id === 1 && index.key?.version === 1 && Object.keys(index.key).length === 2) {
          await coll.dropIndex(index.name!);
        }
      }
    } catch (err) {
      if ((err as { code?: number }).code !== 27 && (err as { code?: number }).code !== 26) throw err;
    }
    await coll.createIndexes([
      { key: { skill_id: 1, version: 1 } },
      { key: { skill_id: 1, is_head: 1, status: 1 } },
      { key: { team_id: 1, owner_agent_id: 1, name: 1 } },
      { key: { is_head: 1, status: 1, created_at_ms: 1 } },
    ]);
    try {
      this.searchIndexReady = await ensureSearchIndex(
        coll,
        SKILL_SEARCH_INDEX,
        SKILL_SEARCH_DEFINITION,
        { waitMs: this.searchIndexWaitMs, logger: this.logger as never },
      );
    } catch (err) {
      this.searchIndexReady = false;
      this.logger?.warn(`${TAG} $search unavailable, skill search degraded: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.db = db;
    this.logger?.info(`${TAG} Initialized db=${db.databaseName} searchIndexReady=${this.searchIndexReady}`);
  }

  private async _ensureInit(): Promise<void> {
    if (!this.initialized) this.init();
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* degraded already set */ }
    }
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: false,
      ftsSearch: this.searchIndexReady && !this.degraded,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  close(): void {
    this.degraded = true;
    this.db = null;
  }

  private async coll(): Promise<Collection> {
    await this._ensureInit();
    if (this.degraded || !this.db) throw new Error(`${TAG} degraded/not-connected`);
    return this.db.collection(COLLECTIONS.SKILLS);
  }

  // ── CRUD ────────────────────────────────────────────────

  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    const coordinator = this.publicationCoordinator;
    if (!coordinator) throw new SkillStoreError("SKILL_PUBLICATION_COORDINATOR_REQUIRED");
    const coll = await this.coll();
    const tid = input.team_id ?? "default";
    const sid = input.skill_id;
    const replay = input.mutation_id ? await this.getByMutationId(sid, input.mutation_id, tid) : null;
    if (replay) return assertSkillMutationMatch(replay, input);
    const head = await this._getHead(coll, sid, tid, { includeArchived: true });
    assertSkillExpectedVersion(input, head);
    if (head && head.name !== input.name) throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
    if (!head) await this._assertNameUnique(coll, input.name, tid, input.owner_agent_id ?? "default", sid);
    const mutationId = input.mutation_id ?? randomUUID();
    const payloadHash = skillPayloadHash(input);
    const committed = await coordinator.execute({
      scope: { team_id: tid, skill_id: sid }, mutation_id: mutationId, payload_hash: payloadHash,
      expected_version: input.expected_version ?? head?.version ?? 0,
      name: input.name, owner_agent_id: head?.owner_agent_id ?? input.owner_agent_id ?? "default",
      previous_head: head,
    }, async () => {
      const rowId = this.ulid();
      const ts = this.now();
      const doc = {
        _id: rowId, row_id: rowId, skill_id: sid, version: (head?.version ?? 0) + 1,
        // This flag means candidate. The control pointer is the only authority.
        is_head: true, team_id: tid, owner_agent_id: head?.owner_agent_id ?? input.owner_agent_id ?? "default",
        user_id: input.user_id ?? "default", task_id: input.task_id ?? "default",
        name: input.name, description: input.description, content: input.content, content_hash: input.content_hash,
        manifest_json: JSON.stringify(input.manifest ?? []), storage_dir: input.storage_dir,
        status: "active", metadata_json: input.metadata_json ?? "{}", created_at_ms: ts, updated_at_ms: ts,
        mutation_id: mutationId, mutation_payload_hash: payloadHash, mutation_request_hash: input.mutation_request_hash,
        search_tokens: tokenizeForFts(`${input.name} ${input.description}`),
      };
      await coll.insertOne(doc as never);
      return this._docToSkill(doc);
    });
    try {
      // Search hint only: authority filtering remains mandatory. A delayed hint
      // from vN must never demote a vN+1 candidate or head.
      await coll.updateMany({ skill_id: sid, team_id: tid, is_head: true,
        version: { $lte: committed.version }, _id: { $ne: committed.row_id },
      } as never, { $set: { is_head: false } } as never);
    } catch (err) {
      this.logger?.warn(`${TAG} committed publication retained; head index hint update failed: ${String(err)}`);
    }
    return committed;
  }

  async getByMutationId(skillId: string, mutationId: string, teamId = "default"): Promise<Skill | null> {
    await this.coll(); // Strict: a degraded store is not a negative lookup.
    return lookupSkillMutation(this.publicationCoordinator, { skill_id: skillId, team_id: teamId }, mutationId);
  }

  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    const coll = await this.collSafe();
    if (!coll) return null;
    return this._getHead(coll, skillId, teamId);
  }

  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    const coll = await this.collSafe();
    if (!coll) return null;
    return this._getHead(coll, skillId, teamId, { includeArchived: true });
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    const coll = await this.collSafe();
    if (!coll) return null;
    const q: Record<string, unknown> = { skill_id: skillId, version };
    if (teamId) q.team_id = teamId;
    return (await this.loadPublicationRows(coll, await this.readPublicationPage(coll, q, 1, 0)))[0] ?? null;
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    const coll = await this.coll();
    const head = await this._getHead(coll, skillId, teamId, { includeArchived: true });
    if (!head) return { archived: false };
    if (this.publicationCoordinator) {
      const scope = { skill_id: skillId, team_id: head.team_id };
      const pointer = await this.publicationCoordinator.getHead(scope);
      await this.publicationCoordinator.archive(scope, pointer ?? {
        row_id: head.row_id, version: head.version, mutation_id: head.mutation_id ?? "legacy", status: head.status,
      }, async () => { /* Managed candidate rows stay immutable; pointer owns status. */ }, head);
    } else {
      await coll.updateOne({ _id: head.row_id } as never, { $set: { status: "archived", updated_at_ms: this.now() } } as never);
    }
    return { archived: true };
  }

  // ── Query ───────────────────────────────────────────────

  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    const coll = await this.collSafe();
    if (!coll) return { items: [], total: 0 };

    const q: Record<string, unknown> = { is_head: true };
    if (opts.team_id) q.team_id = opts.team_id;
    if (opts.owner_agent_id) q.owner_agent_id = opts.owner_agent_id;
    if (opts.user_id) q.user_id = opts.user_id;
    if (opts.task_id) q.task_id = opts.task_id;
    const statuses = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    if (!this.publicationCoordinator) q.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    if (opts.name_prefix) q.name = { $regex: `^${escapeRegex(opts.name_prefix)}` };

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const selected: SkillPublicationCandidate[] = [];
    let total = 0;
    for (let scanOffset = 0; ; scanOffset += 256) {
      const docs = await coll.find(q as never, { projection: PUBLICATION_LIST_PROJECTION })
        .sort({ updated_at_ms: -1, _id: 1 }).skip(scanOffset).limit(256).toArray();
      const heads = await projectPublishedCandidates(docs.map(doc => this.publicationCandidate(doc)), this.publicationCoordinator, true);
      for (const head of heads) {
        if (!statuses.includes(head.status)) continue;
        if (total >= offset && selected.length < limit) selected.push(head);
        total++;
      }
      if (docs.length < 256) break;
    }
    return { items: await this.loadPublicationRows(coll, selected), total };
  }

  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    const coll = await this.collSafe();
    if (!coll || !this.searchIndexReady) return [];

    const searchText = tokenizeForFts(opts.query).trim();
    if (!searchText) return [];
    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);

    const filter: Array<Record<string, unknown>> = [
      { equals: { path: "is_head", value: true } },
      { equals: { path: "status", value: "active" } },
    ];
    if (opts.team_id) filter.push({ equals: { path: "team_id", value: opts.team_id } });
    if (opts.agent_id) filter.push({ equals: { path: "owner_agent_id", value: opts.agent_id } });
    if (opts.task_id) filter.push({ equals: { path: "task_id", value: opts.task_id } });
    if (opts.user_id) filter.push({ equals: { path: "user_id", value: opts.user_id } });

    const pipeline: Record<string, unknown>[] = [
      {
        $search: {
          index: SKILL_SEARCH_INDEX,
          compound: {
            must: [{ text: { query: searchText, path: "search_tokens" } }],
            filter,
          },
        },
      },
      { $limit: topK },
      { $addFields: { __searchScore: { $meta: "searchScore" } } },
    ];

    // The search index is eventually consistent and may rank prepared/old rows
    // ahead of the current head. Expand before authority filtering, not after a
    // topK-sized truncation. Work remains bounded even during orphan storms.
    for (let candidateLimit = Math.max(topK * 4, 32); ; candidateLimit = Math.min(candidateLimit * 2, 1000)) {
      pipeline[1] = { $limit: candidateLimit };
      const docs = await coll.aggregate(pipeline).toArray();
      const published = await projectPublishedCandidates(docs.map(doc => this._docToSkill(doc)), this.publicationCoordinator, true);
      const byId = new Map(published.map(row => [row.row_id, row]));
      const hits: SkillSearchResult[] = [];
      for (const d of docs) {
        const skill = byId.get(String(d.row_id ?? d._id));
        if (!skill?.is_head || skill.status !== "active") continue;
        const score = mongoSearchScoreToScore(Number((d as { __searchScore?: number }).__searchScore ?? 0));
        const snippet = skill.description ? skill.description.slice(0, 200) : undefined;
        hits.push({ skill, score, snippet });
        if (hits.length === topK) return hits;
      }
      if (docs.length < candidateLimit || candidateLimit === 1000) return hits;
    }
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<Skill[]> {
    const coll = await this.collSafe();
    if (!coll) return [];
    const q: Record<string, unknown> = { skill_id: skillId };
    if (teamId) q.team_id = teamId;
    const limit = Math.min(Math.max(pagination?.limit ?? 50, 1), 1000);
    const offset = Math.max(pagination?.offset ?? 0, 0);
    return this.loadPublicationRows(coll, await this.readPublicationPage(coll, q, limit, offset));
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    const coll = await this.collSafe();
    if (!coll) return 0;
    const q: Record<string, unknown> = { skill_id: skillId };
    if (teamId) q.team_id = teamId;
    let count = 0;
    for (let offset = 0; ; offset += 256) {
      const docs = await coll.find(q as never, { projection: PUBLICATION_LIST_PROJECTION })
        .sort({ version: -1, _id: 1 }).skip(offset).limit(256).toArray();
      count += (await projectPublishedCandidates(docs.map(doc => this.publicationCandidate(doc)), this.publicationCoordinator)).length;
      if (docs.length < 256) return count;
    }
  }

  // ── TTL Cleanup ─────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    const coll = await this.coll();
    const rows = await this.publishedRows(await coll.find({ created_at_ms: { $lt: cutoffMs } } as never).toArray());
    return rows.filter(row => !row.is_head && row.status === "active");
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    const coll = await this.coll();
    const row = await this.getByVersion(skillId, version);
    if (!row || row.is_head) return false;
    const res = await coll.deleteOne({ _id: row.row_id } as never);
    return res.deletedCount > 0;
  }

  async getDeletionReceipt(skillId: string, teamId?: string): Promise<SkillDeletionReceipt | null> {
    await this.coll();
    if (!this.publicationCoordinator?.getDeletionReceipt) throw new SkillStoreError("SKILL_PUBLICATION_COORDINATOR_REQUIRED", "durable deletion recovery is unavailable");
    return this.publicationCoordinator.getDeletionReceipt({ skill_id: skillId, team_id: teamId });
  }

  async deleteWithReceipt(request: SkillDeletionRequest, cleanup: SkillDeletionCleanup, options?: { complete?: boolean }): Promise<SkillDeletionResult> {
    const coll = await this.coll();
    const coordinator = this.publicationCoordinator;
    if (!coordinator?.deleteWithReceipt || !coordinator.getDeletionReceipt) throw new SkillStoreError("SKILL_PUBLICATION_COORDINATOR_REQUIRED", "durable deletion recovery is unavailable");
    const head = await this._getHead(coll, request.scope.skill_id, request.scope.team_id, { includeArchived: true });
    const retired = head ? null : await coordinator.getDeletionReceipt(request.scope);
    if (!head && !retired) throw new SkillStoreError("SKILL_NOT_FOUND");
    if ((head?.owner_agent_id ?? retired?.owner_agent_id) !== request.owner_agent_id) throw new SkillStoreError("SKILL_NOT_OWNER");
    const verified = { ...request, ...(head ? { previous_head: head } : {}) };
    return coordinator.deleteWithReceipt(verified, guard => collectSkillDeletionTargets(this, verified, guard), async (receipt, guard) => {
      let deleted = 0;
      for (let offset = 0; offset < receipt.targets.length; offset += 256) {
        await guard();
        const ids = receipt.targets.slice(offset, offset + 256).map(target => target.row_id);
        const result = await coll.deleteMany({ _id: { $in: ids }, skill_id: receipt.scope.skill_id,
          team_id: receipt.scope.team_id, owner_agent_id: receipt.owner_agent_id } as never);
        deleted += result.deletedCount;
      }
      await guard();
      await cleanup(receipt, guard);
      return deleted;
    }, options);
  }

  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    const coll = await this.coll();
    const q: Record<string, unknown> = { skill_id: skillId };
    if (teamId) q.team_id = teamId;
    const docs = teamId ? [] : await coll.find(q as never, { projection: { team_id: 1 } }).toArray();
    const teams = teamId ? [teamId] : [...new Set(docs.map(doc => String(doc.team_id)))];
    let count = 0;
    for (const tid of teams) {
      const head = await this.getHeadIncludingArchived(skillId, tid);
      const retired = head ? null : await this.getDeletionReceipt(skillId, tid);
      if (!head && !retired) continue;
      const expected = head ? { row_id: head.row_id, version: head.version, mutation_id: head.mutation_id ?? `legacy:${head.row_id}`, status: head.status } : retired!.original_head;
      const result = await this.deleteWithReceipt({ scope: { skill_id: skillId, team_id: tid }, owner_agent_id: head?.owner_agent_id ?? retired!.owner_agent_id,
        expected_head: expected, ...(head ? { previous_head: head } : {}) }, async () => {}, { complete: false });
      count += result.deleted_rows;
    }
    return count;
  }

  // ── Internal ────────────────────────────────────────────

  /** Like `coll()` but returns null instead of throwing when degraded (read paths). */
  private async collSafe(): Promise<Collection | null> {
    await this._ensureInit();
    if (this.degraded || !this.db) return null;
    return this.db.collection(COLLECTIONS.SKILLS);
  }

  private async _getHead(
    coll: Collection,
    skillId: string,
    teamId?: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Skill | null> {
    if (teamId && this.publicationCoordinator) {
      const pointer = await this.publicationCoordinator.getHead({ skill_id: skillId, team_id: teamId });
      if (pointer === null) return null;
      if (pointer) {
        const doc = await coll.findOne({ _id: pointer.row_id, skill_id: skillId, team_id: teamId } as never);
        if (!doc) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "authoritative head row unavailable");
        const row = this._docToSkill(doc);
        row.status = pointer.status ?? row.status;
        return !opts?.includeArchived && row.status !== "active" ? null : { ...row, is_head: true };
      }
    }
    const q: Record<string, unknown> = { skill_id: skillId, is_head: true };
    if (teamId) q.team_id = teamId;
    if (!opts?.includeArchived) q.status = "active";
    // Legacy head flags are only candidates once a control pointer exists.
    const rows = await this.publishedRows(await coll.find(q as never).sort({ version: -1 }).toArray());
    return rows.find(row => row.is_head && (opts?.includeArchived || row.status === "active")) ?? null;
  }

  private async _assertNameUnique(
    coll: Collection,
    name: string,
    teamId: string,
    ownerAgentId: string,
    excludeSkillId: string,
  ): Promise<void> {
    const duplicates = await coll.find({
      team_id: teamId,
      owner_agent_id: ownerAgentId,
      name,
      is_head: true,
      status: "active",
    } as never).toArray();
    for (const dup of await this.publishedRows(duplicates)) {
      if (!dup.is_head || dup.status !== "active") continue;
      const dupId = dup.skill_id;
      if (dupId && dupId !== excludeSkillId) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${name}' already exists for agent in team`);
      }
    }
  }

  private publicationCandidate(doc: Document): SkillPublicationCandidate {
    return {
      row_id: String(doc.row_id ?? doc._id), skill_id: String(doc.skill_id), team_id: String(doc.team_id),
      version: Number(doc.version), is_head: doc.is_head === true, status: (doc.status as SkillStatus) ?? "active",
      mutation_id: typeof doc.mutation_id === "string" ? doc.mutation_id : undefined,
    };
  }

  private async readPublicationPage(coll: Collection, query: Record<string, unknown>, limit: number, offset: number): Promise<SkillPublicationCandidate[]> {
    const selected: SkillPublicationCandidate[] = [];
    let visible = 0;
    for (let scanOffset = 0; ; scanOffset += 256) {
      const docs = await coll.find(query as never, { projection: PUBLICATION_LIST_PROJECTION })
        .sort({ version: -1, _id: 1 }).skip(scanOffset).limit(256).toArray();
      for (let index = 0; index < docs.length;) {
        const size = visible < offset ? 16 : Math.min(16, limit - selected.length);
        const candidates = await projectPublishedCandidates(docs.slice(index, index + size).map(doc => this.publicationCandidate(doc)), this.publicationCoordinator);
        index += size;
        for (const candidate of candidates) {
          if (visible++ >= offset) selected.push(candidate);
          if (selected.length === limit) return selected;
        }
      }
      if (docs.length < 256) return selected;
    }
  }

  private async loadPublicationRows(coll: Collection, candidates: SkillPublicationCandidate[]): Promise<Skill[]> {
    if (!candidates.length) return [];
    const docs = await coll.find({ _id: { $in: candidates.map(row => row.row_id) } } as never).toArray();
    const rows = new Map(docs.map(doc => [String(doc.row_id ?? doc._id), this._docToSkill(doc)]));
    return candidates.flatMap(candidate => {
      const row = rows.get(candidate.row_id);
      return row ? [{ ...row, is_head: candidate.is_head, status: candidate.status }] : [];
    });
  }

  private async publishedRows(docs: Document[]): Promise<Skill[]> {
    return projectPublishedCandidates(docs.map(doc => this._docToSkill(doc)), this.publicationCoordinator);
  }

  private _docToSkill(doc: Document): Skill {
    let manifest: SkillManifestEntry[] = [];
    try {
      const raw = (doc as { manifest_json?: string }).manifest_json;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) manifest = parsed;
      }
    } catch { /* ignore */ }
    const d = doc as Record<string, unknown>;
    return {
      mutation_id: typeof d.mutation_id === "string" ? d.mutation_id : undefined,
      mutation_payload_hash: typeof d.mutation_payload_hash === "string" ? d.mutation_payload_hash : undefined,
      mutation_request_hash: typeof d.mutation_request_hash === "string" ? d.mutation_request_hash : undefined,
      row_id: String(d.row_id ?? d._id),
      skill_id: String(d.skill_id ?? ""),
      version: Number(d.version ?? 0),
      is_head: d.is_head === true,
      user_id: String(d.user_id ?? ""),
      owner_agent_id: String(d.owner_agent_id ?? ""),
      team_id: String(d.team_id ?? ""),
      task_id: String(d.task_id ?? ""),
      name: String(d.name ?? ""),
      description: String(d.description ?? ""),
      content: String(d.content ?? ""),
      content_hash: String(d.content_hash ?? ""),
      manifest,
      storage_dir: String(d.storage_dir ?? ""),
      status: (d.status as SkillStatus) ?? "active",
      metadata_json: String(d.metadata_json ?? "{}"),
      created_at_ms: Number(d.created_at_ms ?? 0),
      updated_at_ms: Number(d.updated_at_ms ?? 0),
    };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
