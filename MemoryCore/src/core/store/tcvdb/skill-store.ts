/**
 * TcvdbSkillStore — Skill 存储层的 TCVDB (Service 模式) 实现
 *
 * 实现 ISkillStore 接口，提供技能元数据/内容的 VDB 持久化。
 * 对标 SqliteSkillStore 的 12 个方法，参考 TcvdbMemoryStore 的
 * Collection 创建 / upsert / query / search / hybridSearch 模式。
 *
 * Schema: 详见 docs/design/2026-06-29-skill-vdb-schema.md
 * 接口:   src/core/skill/skill-store.interface.ts
 */

import { randomUUID } from "node:crypto";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
import { randomBase62 } from "../../../utils/short-id.js";
import { TcvdbClient, TcvdbApiError, type QueryResponse } from "./client.js";
import type { BM25LocalEncoder } from "../bm25-local.js";
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

// ─── Config ─────────────────────────────────────────────────────────────

export interface TcvdbSkillStoreConfig {
  /** VDB 实例 URL */
  url: string;
  /** 账户名 (默认 "root") */
  username: string;
  /** API Key */
  apiKey: string;
  /** Database 名称 */
  database: string;
  /** Embedding 模型名 (与 L1 共用 "bge-large-zh") */
  embeddingModel: string;
  /** 请求超时 ms */
  timeout: number;
  /** CA 证书路径 */
  caPemPath?: string;
  logger?: StoreLogger;
  /** BM25 编码器 (shared instance) */
  bm25Encoder?: BM25LocalEncoder;
  /** 注入 ulid 工厂 */
  ulid?: () => string;
  /** 注入 now */
  now?: () => number;
  publicationCoordinator?: SkillPublicationCoordinator;
}

// ─── Constants ──────────────────────────────────────────────────────────

const TAG = "[tcvdb-skill-store]";
const SKILLS_COLLECTION_SUFFIX = "_skills";
const PUBLICATION_LIST_FIELDS = ["id", "skill_id", "team_id", "version", "is_head", "status", "mutation_id", "name"];

/** VDB 密集向量索引 (DISK_FLAT, HNSW fallback) */
const VECTOR_INDEX_DISK_FLAT: Record<string, unknown> = {
  fieldName: "vector",
  fieldType: "vector",
  indexType: "DISK_FLAT",
  dimension: 1024,
  metricType: "COSINE",
  params: { M: 16, efConstruction: 200 },
};
const VECTOR_INDEX_HNSW: Record<string, unknown> = {
  fieldName: "vector",
  fieldType: "vector",
  indexType: "HNSW",
  dimension: 1024,
  metricType: "COSINE",
  params: { M: 16, efConstruction: 200 },
};

/** 查询时返回的字段 (全部, vector/sparse_vector 除外) */
const SKILL_OUTPUT_FIELDS: string[] = [
  "id", "skill_id", "version", "is_head",
  "team_id", "owner_agent_id", "user_id", "task_id",
  "name", "description", "content", "content_hash",
  "manifest_json", "storage_dir", "status", "metadata_json",
  "created_at_ms", "updated_at_ms", "mutation_id", "mutation_payload_hash", "mutation_request_hash",
];

/** 向量字段名 (VDB 内部名) */
const DENSE_VECTOR_FIELD = "vector";
const SPARSE_VECTOR_FIELD = "sparse_vector";

// ─── Ulid helpers ───────────────────────────────────────────────────────

// row_id 生成器 —— VDB doc 的物理主键 (`id` primaryKey field)。
// 与 skill_id 分离：skill_id 在版本间共享，row_id 每一行唯一。
// base62 12 字符（~71 bit CSPRNG 真熵）。
function defaultUlid(): string {
  return randomBase62(12);
}

// ─── Error helpers ──────────────────────────────────────────────────────

function isDiskFlatUnsupported(err: unknown): boolean {
  if (!(err instanceof TcvdbApiError)) return false;
  if (err.apiCode === 15113) return true;
  const msg = err.message.toLowerCase();
  return msg.includes("disk_flat") && msg.includes("not support");
}

// ─── Implementation ─────────────────────────────────────────────────────

export class TcvdbSkillStore implements ISkillStore {
  private publicationCoordinator?: SkillPublicationCoordinator;
  private readonly client: TcvdbClient;
  private readonly skillsCollection: string;
  private readonly embeddingModel: string;
  private readonly logger?: StoreLogger;
  private readonly bm25Encoder?: BM25LocalEncoder;
  private readonly ulid: () => string;
  private readonly now: () => number;

  private degraded = false;
  private initPromise?: Promise<void>;
  private initialized = false;

  constructor(config: TcvdbSkillStoreConfig) {
    this.publicationCoordinator = config.publicationCoordinator;
    this.client = new TcvdbClient({
      url: config.url,
      username: config.username,
      apiKey: config.apiKey,
      database: config.database,
      timeout: config.timeout,
      caPemPath: config.caPemPath,
    });
    this.skillsCollection = `${config.database}${SKILLS_COLLECTION_SUFFIX}`;
    this.embeddingModel = config.embeddingModel;
    this.logger = config.logger;
    this.bm25Encoder = config.bm25Encoder;
    this.ulid = config.ulid ?? defaultUlid;
    this.now = config.now ?? (() => Date.now());
  }

  setPublicationCoordinator(coordinator: SkillPublicationCoordinator): void {
    this.publicationCoordinator = coordinator;
  }

  // ── ISkillStore: 生命周期 ─────────────────────────────────────────────

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.initPromise = this._initAsync().catch((err) => {
      this.logger?.error(`${TAG} Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    });
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: !this.degraded,
      ftsSearch: !!this.bm25Encoder && !this.degraded,
      nativeHybridSearch: !!this.bm25Encoder && !this.degraded,
      sparseVectors: !!this.bm25Encoder,
    };
  }

  close(): void {
    this.degraded = true;
  }

  // ── ISkillStore: CRUD ─────────────────────────────────────────────────

  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    const coordinator = this.publicationCoordinator;
    if (!coordinator) throw new SkillStoreError("SKILL_PUBLICATION_COORDINATOR_REQUIRED");
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    const tid = input.team_id ?? "default";
    const sid = input.skill_id;
    const replay = input.mutation_id ? await this.getByMutationId(sid, input.mutation_id, tid) : null;
    if (replay) return assertSkillMutationMatch(replay, input);
    const head = await this._getHeadAsync(sid, tid, { includeArchived: true });
    assertSkillExpectedVersion(input, head);
    if (head && head.name !== input.name) throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
    if (!head) await this._assertNameUnique(input.name, tid, input.owner_agent_id ?? "default", sid);
    const mutationId = input.mutation_id ?? randomUUID();
    const payloadHash = skillPayloadHash(input);
    const committed = await coordinator.execute({
      scope: { team_id: tid, skill_id: sid }, mutation_id: mutationId, payload_hash: payloadHash,
      expected_version: input.expected_version ?? head?.version ?? 0,
      name: input.name, owner_agent_id: head?.owner_agent_id ?? input.owner_agent_id ?? "default",
      previous_head: head,
    }, async () => {
      const ts = this.now();
      const doc: Record<string, unknown> = {
        id: this.ulid(), skill_id: sid, version: (head?.version ?? 0) + 1,
        // This physical candidate is invisible until the authority's pointer CAS.
        // A late upsert cannot overwrite another attempt or flip an old head.
        is_head: 1, team_id: tid, owner_agent_id: head?.owner_agent_id ?? input.owner_agent_id ?? "default",
        user_id: input.user_id ?? "default", task_id: input.task_id ?? "default",
        name: input.name, description: input.description, content: input.content, content_hash: input.content_hash,
        manifest_json: JSON.stringify(input.manifest ?? []), storage_dir: input.storage_dir,
        status: "active", metadata_json: input.metadata_json ?? "{}", created_at_ms: ts, updated_at_ms: ts,
        mutation_id: mutationId, mutation_payload_hash: payloadHash, mutation_request_hash: input.mutation_request_hash ?? "",
      };
      if (this.bm25Encoder) {
        const sparse = this.bm25Encoder.encodeTexts([input.content]);
        if (sparse[0]?.length) doc[SPARSE_VECTOR_FIELD] = sparse[0];
      }
      await this.client.upsert(this.skillsCollection, [doc]);
      return this._docToSkill(doc);
    });
    try {
      // IDs come from this scope and version <= the confirmed publication.
      // A delayed hint update cannot demote later versions. This is optional
      // index maintenance, never an authority change or a publication CAS.
      const candidates = await this.queryAll(`skill_id="${this._escape(sid)}" and team_id="${this._escape(tid)}" and is_head=1 and version<=${committed.version}`);
      const ids = candidates.filter(doc => doc.id !== committed.row_id).map(doc => String(doc.id));
      for (let offset = 0; offset < ids.length; offset += 1000) {
        await this.client.update(this.skillsCollection, { documentIds: ids.slice(offset, offset + 1000), update: { is_head: 0 } });
      }
    } catch (err) {
      this.logger?.warn(`${TAG} committed publication retained; head index hint update failed: ${String(err)}`);
    }
    return committed;
  }

  async getByMutationId(skillId: string, mutationId: string, teamId = "default"): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    return lookupSkillMutation(this.publicationCoordinator, { skill_id: skillId, team_id: teamId }, mutationId);
  }

  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    return this._getHeadAsync(skillId, teamId);
  }

  /**
   * 内部使用：获取当前 head 但不过滤 status。archived head 也会返回。
   * 与 `SqliteSkillStore.getHeadIncludingArchived` 语义一致。
   * 供 `SkillCore.delete` 幂等回读、asset 补偿任务、管控台使用。
   */
  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    return this._getHeadAsync(skillId, teamId, { includeArchived: true });
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and version=${version} and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}" and version=${version}`;

    return (await this.loadPublicationRows(await this.readPublicationPage(filter, 1, 0)))[0] ?? null;
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    const head = await this._getHeadAsync(skillId, teamId, { includeArchived: true });
    if (!head) return { archived: false };
    if (this.publicationCoordinator) {
      const scope = { skill_id: skillId, team_id: head.team_id };
      const pointer = await this.publicationCoordinator.getHead(scope);
      await this.publicationCoordinator.archive(scope, pointer ?? {
        row_id: head.row_id, version: head.version, mutation_id: head.mutation_id ?? "legacy", status: head.status,
      }, async () => { /* Candidate immutable; external pointer is status authority. */ }, head);
    } else {
      await this._updateDocAsync(head.row_id, { status: "archived", updated_at_ms: this.now() });
    }
    return { archived: true };
  }

  // ── ISkillStore: 查询 ─────────────────────────────────────────────────

  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    await this._ensureInit();
    if (this.degraded) return { items: [], total: 0 };
    const conditions = ["is_head=1"];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.owner_agent_id) conditions.push(`owner_agent_id="${this._escape(opts.owner_agent_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);
    const statuses = opts.status?.length ? opts.status : ["active"];
    const offset = Math.max(opts.offset ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const selected: SkillPublicationCandidate[] = [];
    let total = 0;
    for (let scanOffset = 0; ; scanOffset += 256) {
      const response = await this.client.query(this.skillsCollection, {
        filter: conditions.join(" and "), offset: scanOffset, limit: 256, outputFields: PUBLICATION_LIST_FIELDS,
        sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
      });
      const docs = response.documents ?? [];
      const heads = await projectPublishedCandidates(docs.map(doc => this.publicationCandidate(doc)), this.publicationCoordinator, true);
      for (const head of heads) {
        if (!statuses.includes(head.status) || (opts.name_prefix && !head.name.startsWith(opts.name_prefix))) continue;
        if (total >= offset && selected.length < limit) selected.push(head);
        total++;
      }
      if (docs.length < 256) break;
    }
    return { items: await this.loadPublicationRows(selected), total };
  }

  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const filter = this._buildSearchFilter(opts);
    const mode = opts.mode ?? "bm25";

    try {
      // TCVDB search has no stable continuation token. Re-run with a bounded
      // larger candidate set when old/prepared rows occupy the initial topK.
      for (let candidateLimit = Math.max(topK * 4, 32); ; candidateLimit = Math.min(candidateLimit * 2, 1000)) {
        const candidates = mode === "hybrid" && this.bm25Encoder
          ? await this._searchHybridAsync(opts.query, candidateLimit, filter)
          : mode === "embedding"
            ? await this._searchEmbeddingAsync(opts.query, candidateLimit, filter)
            : await this._searchBm25Async(opts.query, candidateLimit, filter);
        const hits = await this.publishedSearch(candidates);
        if (hits.length >= topK || candidates.length < candidateLimit || candidateLimit === 1000) return hits.slice(0, topK);
      }
    } catch (err) {
      this.logger?.warn(`${TAG} searchSkills failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<Skill[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}"`;

    const limit = Math.min(Math.max(pagination?.limit ?? 50, 1), 1000);
    const offset = Math.max(pagination?.offset ?? 0, 0);

    return this.loadPublicationRows(await this.readPublicationPage(filter, limit, offset));
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;
    const filter = `skill_id="${this._escape(skillId)}"` + (teamId ? ` and team_id="${this._escape(teamId)}"` : "");
    let count = 0;
    for (let offset = 0; ; offset += 256) {
      const response = await this.client.query(this.skillsCollection, {
        filter, offset, limit: 256, outputFields: PUBLICATION_LIST_FIELDS,
        sort: [{ fieldName: "version", direction: "desc" }],
      });
      const docs = response.documents ?? [];
      count += (await projectPublishedCandidates(docs.map(doc => this.publicationCandidate(doc)), this.publicationCoordinator)).length;
      if (docs.length < 256) return count;
    }
  }

  // ── ISkillStore: TTL Cleanup ─────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    await this._ensureInit();
    if (this.degraded) return [];
    const rows = await this.publishedRows(await this.queryAll(`created_at_ms<${cutoffMs}`));
    return rows.filter(row => !row.is_head && row.status === "active" && row.created_at_ms < cutoffMs);
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    const row = await this.getByVersion(skillId, version);
    if (!row || row.is_head) return false;
    return (await this.client.deleteDoc(this.skillsCollection, { query: { documentIds: [row.row_id] } })) > 0;
  }

  async getDeletionReceipt(skillId: string, teamId?: string): Promise<SkillDeletionReceipt | null> {
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    if (!this.publicationCoordinator?.getDeletionReceipt) throw new SkillStoreError("SKILL_PUBLICATION_COORDINATOR_REQUIRED", "durable deletion recovery is unavailable");
    return this.publicationCoordinator.getDeletionReceipt({ skill_id: skillId, team_id: teamId });
  }

  async deleteWithReceipt(request: SkillDeletionRequest, cleanup: SkillDeletionCleanup, options?: { complete?: boolean }): Promise<SkillDeletionResult> {
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    const coordinator = this.publicationCoordinator;
    if (!coordinator?.deleteWithReceipt || !coordinator.getDeletionReceipt) throw new SkillStoreError("SKILL_PUBLICATION_COORDINATOR_REQUIRED", "durable deletion recovery is unavailable");
    const head = await this._getHeadAsync(request.scope.skill_id, request.scope.team_id, { includeArchived: true });
    const retired = head ? null : await coordinator.getDeletionReceipt(request.scope);
    if (!head && !retired) throw new SkillStoreError("SKILL_NOT_FOUND");
    if ((head?.owner_agent_id ?? retired?.owner_agent_id) !== request.owner_agent_id) throw new SkillStoreError("SKILL_NOT_OWNER");
    const verified = { ...request, ...(head ? { previous_head: head } : {}) };
    return coordinator.deleteWithReceipt(verified, guard => collectSkillDeletionTargets(this, verified, guard), async (receipt, guard) => {
      let deleted = 0;
      for (let offset = 0; offset < receipt.targets.length; offset += 256) {
        await guard();
        const ids = receipt.targets.slice(offset, offset + 256).map(target => target.row_id);
        // TCVDB's primary-key deletion has no owner predicate. Validate any
        // remaining immutable rows before issuing the exact frozen IDs.
        const current = await this.client.query(this.skillsCollection, { documentIds: ids, limit: ids.length,
          outputFields: ["id", "skill_id", "team_id", "owner_agent_id"] });
        if ((current.documents ?? []).some(doc => doc.skill_id !== receipt.scope.skill_id || doc.team_id !== receipt.scope.team_id || doc.owner_agent_id !== receipt.owner_agent_id)) {
          throw new SkillStoreError("SKILL_NOT_OWNER", "deletion target ownership changed");
        }
        await guard();
        deleted += await this.client.deleteDoc(this.skillsCollection, { query: { documentIds: ids } });
      }
      await guard();
      await cleanup(receipt, guard);
      return deleted;
    }, options);
  }

  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "store degraded");
    const baseFilter = `skill_id="${this._escape(skillId)}"`;
    const docs = teamId ? [] : await this.queryAll(baseFilter);
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

  // ─── Private: Init ────────────────────────────────────────────────────

  private async _initAsync(): Promise<void> {
    try {
      const dbCreated = await this.client.createDatabase();
      if (dbCreated) {
        this.logger?.debug?.(`${TAG} Database created, waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    } catch (err) {
      if (err instanceof TcvdbApiError && err.apiCode === 15201) {
        this.logger?.debug?.(`${TAG} Database already exists (benign)`);
      } else {
        throw err;
      }
    }

    // Create skills collection with DISK_FLAT → HNSW fallback
    await this._createCollectionWithVectorFallback(
      {
        collection: this.skillsCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Skill 技能存储",
        embedding: {
          status: "enabled",
          field: "content",
          vectorField: DENSE_VECTOR_FIELD,
          model: this.embeddingModel,
        },
      },
      [
        { fieldName: "skill_id",       fieldType: "string", indexType: "filter" },
        { fieldName: "version",        fieldType: "uint64", indexType: "filter" },
        { fieldName: "is_head",        fieldType: "uint64", indexType: "filter" },
        { fieldName: "team_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "owner_agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "user_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "task_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "name",           fieldType: "string", indexType: "filter" },
        { fieldName: "status",         fieldType: "string", indexType: "filter" },
        { fieldName: "created_at_ms",  fieldType: "uint64", indexType: "filter" },
        { fieldName: "updated_at_ms",  fieldType: "uint64", indexType: "filter" },
      ],
    );

    this.logger?.info(`${TAG} Initialized: collection=${this.skillsCollection}, model=${this.embeddingModel}`);
  }

  private async _createCollectionWithVectorFallback(
    params: Record<string, unknown>,
    filterIndexes: Array<Record<string, unknown>>,
  ): Promise<void> {
    const buildIndexes = (vectorIndex: Record<string, unknown>) => [
      { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
      vectorIndex,
      { fieldName: SPARSE_VECTOR_FIELD, fieldType: "sparseVector", indexType: "inverted", metricType: "IP", diskSwapEnabled: true },
      ...filterIndexes,
    ];

    try {
      await this.client.createCollection({ ...params, indexes: buildIndexes(VECTOR_INDEX_DISK_FLAT) });
    } catch (err) {
      if (isDiskFlatUnsupported(err)) {
        this.logger?.debug?.(`${TAG} DISK_FLAT not supported, falling back to HNSW`);
        await this.client.createCollection({ ...params, indexes: buildIndexes(VECTOR_INDEX_HNSW) });
      } else {
        throw err;
      }
    }
  }

  private async _ensureInit(): Promise<void> {
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* degraded already set */ }
    }
  }

  // ─── Private: Query helpers ───────────────────────────────────────────

  /**
   * 查 head 行。默认强制 `status="active"`；`includeArchived=true` 时不加 status 过滤，
   * 供 `getHeadIncludingArchived` 使用（archived head 的幂等回读 / 补偿任务）。
   *
   * Controlled skills resolve by exact authoritative row ID. Legacy candidates
   * are projected through receipts before version ordering; reads never mutate
   * candidate rows or elect a winner using timestamps.
   */
  private async _getHeadAsync(
    skillId: string,
    teamId?: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Skill | null> {
    if (teamId && this.publicationCoordinator) {
      const pointer = await this.publicationCoordinator.getHead({ skill_id: skillId, team_id: teamId });
      if (pointer === null) return null;
      if (pointer) {
        const resp = await this.client.query(this.skillsCollection, { documentIds: [pointer.row_id], limit: 1, outputFields: SKILL_OUTPUT_FIELDS });
        const doc = resp.documents?.[0];
        if (!doc || doc.skill_id !== skillId || doc.team_id !== teamId) throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", "authoritative head row unavailable");
        const row = { ...this._docToSkill(doc), is_head: true, status: pointer.status ?? (doc.status as SkillStatus) };
        return !opts?.includeArchived && row.status !== "active" ? null : row;
      }
    }
    const filter = `skill_id="${this._escape(skillId)}" and is_head=1` + (teamId ? ` and team_id="${this._escape(teamId)}"` : "");
    const rows = await this.publishedRows(await this.queryAll(filter));
    return rows.filter(row => row.is_head && (opts?.includeArchived || row.status === "active"))
      .sort((a, b) => b.version - a.version || b.updated_at_ms - a.updated_at_ms || a.row_id.localeCompare(b.row_id))[0] ?? null;
  }

  private async queryAll(filter: string): Promise<Record<string, unknown>[]> {
    const docs: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 1000) {
      const resp = await this.client.query(this.skillsCollection, {
        filter, offset, limit: 1000, outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "created_at_ms", direction: "asc" }],
      });
      const page = resp.documents ?? [];
      docs.push(...page);
      if (page.length < 1000) return docs;
    }
  }

  private publicationCandidate(doc: Record<string, unknown>): SkillPublicationCandidate & { name: string } {
    return {
      row_id: String(doc.id ?? doc.row_id), skill_id: String(doc.skill_id), team_id: String(doc.team_id),
      version: Number(doc.version), is_head: doc.is_head === 1, status: (doc.status as SkillStatus) ?? "active",
      mutation_id: typeof doc.mutation_id === "string" ? doc.mutation_id : undefined, name: String(doc.name ?? ""),
    };
  }

  private async readPublicationPage(filter: string, limit: number, offset: number): Promise<SkillPublicationCandidate[]> {
    const selected: SkillPublicationCandidate[] = [];
    let visible = 0;
    for (let scanOffset = 0; ; scanOffset += 256) {
      const response = await this.client.query(this.skillsCollection, {
        filter, offset: scanOffset, limit: 256, outputFields: PUBLICATION_LIST_FIELDS,
        sort: [{ fieldName: "version", direction: "desc" }],
      });
      const docs = response.documents ?? [];
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

  private async loadPublicationRows(candidates: SkillPublicationCandidate[]): Promise<Skill[]> {
    if (!candidates.length) return [];
    const response = await this.client.query(this.skillsCollection, {
      documentIds: candidates.map(row => row.row_id), limit: candidates.length, outputFields: SKILL_OUTPUT_FIELDS,
    });
    const rows = new Map((response.documents ?? []).map(doc => [String(doc.id), this._docToSkill(doc)]));
    return candidates.flatMap(candidate => {
      const row = rows.get(candidate.row_id);
      return row ? [{ ...row, is_head: candidate.is_head, status: candidate.status }] : [];
    });
  }

  private async publishedRows(docs: Record<string, unknown>[]): Promise<Skill[]> {
    return projectPublishedCandidates(docs.map(doc => this._docToSkill(doc)), this.publicationCoordinator);
  }

  private async publishedSearch(hits: SkillSearchResult[]): Promise<SkillSearchResult[]> {
    const published = await projectPublishedCandidates(hits.map(hit => hit.skill), this.publicationCoordinator, true);
    const byId = new Map(published.map(row => [row.row_id, row]));
    const result: SkillSearchResult[] = [];
    for (const hit of hits) {
      const skill = byId.get(hit.skill.row_id);
      if (skill?.is_head && skill.status === "active") result.push({ ...hit, skill });
    }
    return result;
  }

  // ─── Private: Write helpers ───────────────────────────────────────────

  /** Upsert 更新文档的部分字段 (保留未传字段) */
  private async _updateDocAsync(rowId: string, partial: Record<string, unknown>): Promise<void> {
    // VDB upsert 需要完整文档或至少 id + 变更字段
    // 先读取现有文档，合并后 upsert
    const existing = await this._queryByIdAsync(rowId);
    if (!existing) return;

    const doc = this._skillToDoc(existing);
    Object.assign(doc, partial);
    await this.client.upsert(this.skillsCollection, [doc]);
  }

  /**
   * 按主键 (id / row_id) 取一条。
   * 注意：id 是 primaryKey 而非 filter 索引，不能用 `filter: id="..."` 查询
   * （VDB 会报 Field Not Found:id 被 catch 成 null）。必须走 documentIds 主键查找，
   * 对齐 memory 生产实现 (tcvdb.ts "Primary key lookup: use documentIds")。
   */
  private async _queryByIdAsync(rowId: string): Promise<Skill | null> {
    try {
      const resp = await this.client.query(this.skillsCollection, {
        documentIds: [rowId],
        limit: 1,
        retrieveVector: false,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      return resp.documents && resp.documents.length > 0
        ? this._docToSkill(resp.documents[0])
        : null;
    } catch (err) {
      this.logger?.warn(`${TAG} queryById failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Name 唯一性校验 (同 team + agent + name 且 is_head=1 且 status=active) */
  private async _assertNameUnique(
    name: string,
    teamId: string,
    ownerAgentId: string,
    excludeSkillId: string,
  ): Promise<void> {
    const filter =
      `team_id="${this._escape(teamId)}" and owner_agent_id="${this._escape(ownerAgentId)}" ` +
      `and name="${this._escape(name)}" and is_head=1 and status="active"`;

    const rows = await this.publishedRows(await this.queryAll(filter));
    if (rows.some(row => row.is_head && row.status === "active" && row.skill_id !== excludeSkillId)) {
      throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${name}' already exists for agent in team`);
    }
  }

  // ─── Private: Search ─────────────────────────────────────────────────

  private _buildSearchFilter(opts: SearchSkillsOptions): string {
    const conditions: string[] = ["is_head=1", 'status="active"'];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.agent_id) conditions.push(`owner_agent_id="${this._escape(opts.agent_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    return conditions.join(" and ");
  }

  /**
   * bm25 模式：TCVDB 无纯稀疏检索通道（/document/search 只做 dense；
   * hybridSearch 的 ann 为必填）。skill collection 的服务端 embedding 恒开启，
   * 故 bm25 模式在 Service 模式下降级为 hybrid（dense + sparse），
   * 语义等价且检索质量不弱于纯 BM25。standalone(SQLite) 才是真正的纯 BM25。
   */
  private async _searchBm25Async(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    this.logger?.debug?.(
      `${TAG} bm25 mode on TCVDB → degrade to hybrid (server-side embedding always enabled, no pure-sparse channel)`,
    );
    return this._searchHybridAsync(queryText, topK, filter);
  }

  /**
   * embedding 模式：dense-only。走 /document/search + embeddingItems，
   * 由 VDB 服务端对 query 文本做 embedding（collection.embedding.field=content）。
   * 注意：/document/search 不接受 ann/match，服务端 embedding 用 embeddingItems 传原始文本。
   */
  private async _searchEmbeddingAsync(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    const resp = await this.client.search(this.skillsCollection, {
      embeddingItems: [queryText],
      filter,
      limit: topK,
      retrieveVector: false,
      outputFields: SKILL_OUTPUT_FIELDS,
    });

    return this._parseSearchResponse(resp, topK);
  }

  /**
   * hybrid 模式：dense(服务端 embedding) + sparse(BM25) + RRF 融合。
   * 对齐 memory 生产实现 (tcvdb.ts searchL1HybridAsync)：
   *   - ann / match 均为数组
   *   - ann.fieldName = 服务端 embedding 源字段 "content"，data 传原始 query 文本
   *   - query 侧稀疏向量用 encodeQueries（IDF 权重），与写入侧 encodeTexts（TF）区分
   *   - rerank: { method: "rrf", k: 60 }
   * 无 BM25 编码器时退化为 dense-only（embedding）。
   */
  private async _searchHybridAsync(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
    const sparseVec: SparseVector | undefined =
      sparse.length > 0 && sparse[0] && sparse[0].length > 0 ? sparse[0] : undefined;

    if (!sparseVec) {
      // 无稀疏信号 → dense-only
      return this._searchEmbeddingAsync(queryText, topK, filter);
    }

    const searchParams: Record<string, unknown> = {
      filter,
      limit: topK,
      retrieveVector: false,
      outputFields: SKILL_OUTPUT_FIELDS,
      ann: [{
        fieldName: "content",
        data: [queryText],
        limit: Math.min(topK * 2, 1000),
      }],
      match: [{
        fieldName: SPARSE_VECTOR_FIELD,
        data: [sparseVec],
        limit: Math.min(topK * 2, 1000),
      }],
      rerank: {
        method: "rrf",
        k: 60,
      },
    };

    const resp = await this.client.hybridSearch(this.skillsCollection, searchParams);
    return this._parseSearchResponse(resp, topK);
  }

  private _parseSearchResponse(
    resp: { documents: Array<Array<Record<string, unknown>>> },
    topK: number,
  ): SkillSearchResult[] {
    const results: SkillSearchResult[] = [];
    const docs = resp.documents?.[0] ?? [];

    for (const d of docs) {
      if (results.length >= topK) break;
      const skill = this._docToSkill(d);
      const score = (d.score as number) ?? 0;
      let snippet: string | undefined;
      if (d.text !== undefined && typeof d.text === "string") {
        snippet = d.text.slice(0, 200);
      }
      results.push({ skill, score, snippet });
    }

    return results;
  }

  // ─── Private: Doc ↔ Skill mapping ─────────────────────────────────────

  private _docToSkill(doc: Record<string, unknown>): Skill {
    let manifest: SkillManifestEntry[] = [];
    try {
      const raw = doc.manifest_json as string | undefined;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) manifest = parsed;
      }
    } catch { /* ignore */ }

    return {
      mutation_id: typeof doc.mutation_id === "string" ? doc.mutation_id : undefined,
      mutation_payload_hash: typeof doc.mutation_payload_hash === "string" ? doc.mutation_payload_hash : undefined,
      mutation_request_hash: typeof doc.mutation_request_hash === "string" ? doc.mutation_request_hash : undefined,
      row_id: (doc.id ?? doc.row_id) as string,
      skill_id: doc.skill_id as string,
      version: (doc.version as number) ?? 0,
      is_head: (doc.is_head as number) === 1,
      user_id: doc.user_id as string,
      owner_agent_id: doc.owner_agent_id as string,
      team_id: doc.team_id as string,
      task_id: doc.task_id as string,
      name: doc.name as string,
      description: doc.description as string,
      content: doc.content as string,
      content_hash: doc.content_hash as string,
      manifest,
      storage_dir: doc.storage_dir as string,
      status: (doc.status as SkillStatus) ?? "active",
      metadata_json: (doc.metadata_json as string) ?? "{}",
      created_at_ms: (doc.created_at_ms as number) ?? 0,
      updated_at_ms: (doc.updated_at_ms as number) ?? 0,
    };
  }

  /** Skill → VDB doc (用于 update 时重写) */
  private _skillToDoc(skill: Skill): Record<string, unknown> {
    return {
      mutation_id: skill.mutation_id,
      mutation_payload_hash: skill.mutation_payload_hash,
      mutation_request_hash: skill.mutation_request_hash,
      id: skill.row_id,
      skill_id: skill.skill_id,
      version: skill.version,
      is_head: skill.is_head ? 1 : 0,
      team_id: skill.team_id,
      owner_agent_id: skill.owner_agent_id,
      user_id: skill.user_id,
      task_id: skill.task_id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      content_hash: skill.content_hash,
      manifest_json: JSON.stringify(skill.manifest),
      storage_dir: skill.storage_dir,
      status: skill.status,
      metadata_json: skill.metadata_json,
      created_at_ms: skill.created_at_ms,
      updated_at_ms: skill.updated_at_ms,
    };
  }

  // ─── Private: String escape ───────────────────────────────────────────

  private _escape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
