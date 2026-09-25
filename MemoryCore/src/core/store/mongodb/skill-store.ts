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

import type { Collection, Db, Document } from "mongodb";
import type { MongoConfig } from "../../instance-config-provider.js";
import type { MongoClientPool } from "./client-pool.js";
import type { StoreLogger } from "../types.js";
import type {
  ISkillStore,
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
import { SkillStoreError } from "../../skill/skill-store.interface.js";
import { randomBase62 } from "../../../utils/short-id.js";
import { tokenizeForFts, mongoSearchScoreToScore } from "../tokenize.js";
import { COLLECTIONS } from "./collections.js";
import {
  SKILL_SEARCH_INDEX,
  SKILL_SEARCH_DEFINITION,
  ensureSearchIndex,
} from "./search-index.js";

const TAG = "[mongo-skill-store]";

export interface MongoSkillStoreConfig {
  pool: MongoClientPool;
  mongoConfig: MongoConfig;
  logger?: StoreLogger;
  ulid?: () => string;
  now?: () => number;
  searchIndexWaitMs?: number;
}

function defaultUlid(): string {
  return randomBase62(12);
}

export class MongoSkillStore implements ISkillStore {
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
    this.pool = config.pool;
    this.mongoConfig = config.mongoConfig;
    this.logger = config.logger;
    this.ulid = config.ulid ?? defaultUlid;
    this.now = config.now ?? (() => Date.now());
    this.searchIndexWaitMs = config.searchIndexWaitMs ?? 60_000;
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
    await coll.createIndexes([
      { key: { skill_id: 1, version: 1 }, unique: true },
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
    const coll = await this.coll();
    const tid = input.team_id ?? "default";
    const sid = input.skill_id;

    const head = await this._getHead(coll, sid, tid, { includeArchived: true });
    const activeHead = head && head.status === "active" ? head : null;

    if (!head) {
      await this._assertNameUnique(coll, input.name, tid, input.owner_agent_id ?? "default", sid);
    } else if (head.name !== input.name) {
      throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
    }

    const newVersion = head ? head.version + 1 : 1;
    const existing = await coll.findOne({ skill_id: sid, version: newVersion, team_id: tid } as never);
    if (existing) return this._docToSkill(existing);

    const ownerForRow = head ? head.owner_agent_id : (input.owner_agent_id ?? "default");
    const userIdForRow = input.user_id ?? "default";
    const ts = this.now();
    const rowId = this.ulid();
    const storageDir = `skills/${sid}/v${newVersion}`;

    const doc: Record<string, unknown> = {
      _id: rowId,
      row_id: rowId,
      skill_id: sid,
      version: newVersion,
      is_head: true,
      team_id: tid,
      owner_agent_id: ownerForRow,
      user_id: userIdForRow,
      task_id: input.task_id ?? "default",
      name: input.name,
      description: input.description,
      content: input.content,
      content_hash: input.content_hash,
      manifest_json: JSON.stringify(input.manifest ?? []),
      storage_dir: storageDir,
      status: "active",
      metadata_json: input.metadata_json ?? "{}",
      created_at_ms: ts,
      updated_at_ms: ts,
      search_tokens: tokenizeForFts(`${input.name} ${input.description}`),
    };

    // New row first, then flip old head — matches VDB's compensating order so a
    // crash between the two leaves the newest version resolvable by version DESC.
    await coll.insertOne(doc as never);
    if (activeHead) {
      await coll.updateOne(
        { _id: activeHead.row_id } as never,
        { $set: { is_head: false } } as never,
      );
    }

    return this._docToSkill(doc);
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
    const doc = await coll.findOne(q as never);
    return doc ? this._docToSkill(doc) : null;
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    const coll = await this.collSafe();
    if (!coll) return { archived: false };
    const head = await this._getHead(coll, skillId, teamId);
    if (!head) return { archived: false };
    await coll.updateOne(
      { _id: head.row_id } as never,
      { $set: { status: "archived", updated_at_ms: this.now() } } as never,
    );
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
    q.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    if (opts.name_prefix) q.name = { $regex: `^${escapeRegex(opts.name_prefix)}` };

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const total = await coll.countDocuments(q as never);
    const docs = await coll
      .find(q as never)
      .sort({ updated_at_ms: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    return { items: docs.map((d) => this._docToSkill(d)), total };
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

    const docs = await coll.aggregate(pipeline).toArray();
    return docs.map((d) => {
      const skill = this._docToSkill(d);
      const score = mongoSearchScoreToScore(Number((d as { __searchScore?: number }).__searchScore ?? 0));
      const snippet = skill.description ? skill.description.slice(0, 200) : undefined;
      return { skill, score, snippet };
    });
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
    const docs = await coll
      .find(q as never)
      .sort({ version: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    return docs.map((d) => this._docToSkill(d));
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    const coll = await this.collSafe();
    if (!coll) return 0;
    const q: Record<string, unknown> = { skill_id: skillId };
    if (teamId) q.team_id = teamId;
    return coll.countDocuments(q as never);
  }

  // ── TTL Cleanup ─────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    const coll = await this.collSafe();
    if (!coll) return [];
    const docs = await coll
      .find({ is_head: false, status: "active", created_at_ms: { $lt: cutoffMs } } as never)
      .sort({ created_at_ms: 1 })
      .limit(10000)
      .toArray();
    return docs.map((d) => ({
      skill_id: String((d as { skill_id?: string }).skill_id ?? ""),
      version: Number((d as { version?: number }).version ?? 0),
      is_head: (d as { is_head?: boolean }).is_head === true,
      status: ((d as { status?: SkillStatus }).status ?? "active") as SkillStatus,
      storage_dir: String((d as { storage_dir?: string }).storage_dir ?? ""),
      created_at_ms: Number((d as { created_at_ms?: number }).created_at_ms ?? 0),
    }));
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    const coll = await this.collSafe();
    if (!coll) return false;
    const res = await coll.deleteOne({ skill_id: skillId, version, is_head: false } as never);
    return res.deletedCount > 0;
  }

  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    const coll = await this.collSafe();
    if (!coll) return 0;
    const q: Record<string, unknown> = { skill_id: skillId };
    if (teamId) q.team_id = teamId;
    const res = await coll.deleteMany(q as never);
    return res.deletedCount;
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
    const q: Record<string, unknown> = { skill_id: skillId, is_head: true };
    if (teamId) q.team_id = teamId;
    if (!opts?.includeArchived) q.status = "active";
    // version DESC guards against a transient double-head (crash between insert
    // and flip): the newest version wins.
    const doc = await coll.find(q as never).sort({ version: -1 }).limit(1).next();
    return doc ? this._docToSkill(doc) : null;
  }

  private async _assertNameUnique(
    coll: Collection,
    name: string,
    teamId: string,
    ownerAgentId: string,
    excludeSkillId: string,
  ): Promise<void> {
    const dup = await coll.findOne({
      team_id: teamId,
      owner_agent_id: ownerAgentId,
      name,
      is_head: true,
      status: "active",
    } as never);
    if (dup) {
      const dupId = (dup as { skill_id?: string }).skill_id;
      if (dupId && dupId !== excludeSkillId) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${name}' already exists for agent in team`);
      }
    }
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
