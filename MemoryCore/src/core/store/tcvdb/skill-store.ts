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

import { randomBase62 } from "../../../utils/short-id.js";
import { TcvdbClient, TcvdbApiError, type QueryResponse } from "./client.js";
import type { BM25LocalEncoder } from "../bm25-local.js";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
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
}

// ─── Constants ──────────────────────────────────────────────────────────

const TAG = "[tcvdb-skill-store]";
const SKILLS_COLLECTION_SUFFIX = "_skills";

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
  "created_at_ms", "updated_at_ms",
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
    await this._ensureInit();
    if (this.degraded) throw new Error("TcvdbSkillStore degraded");

    const tid = input.team_id ?? "default";
    const sid = input.skill_id;

    // 1. 查旧 head
    const head = await this._getHeadAsync(sid, tid);

    // 2. Name 唯一性校验 (无 head → 新 skill, 检查重名)
    if (!head) {
      await this._assertNameUnique(input.name, tid, input.owner_agent_id ?? "default", sid);
    } else {
      // 已有 history → name 不可变
      if (head.name !== input.name) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
      }
    }

    // 3. 版本唯一性校验
    const newVersion = head ? head.version + 1 : 1;
    const existing = await this._queryOneAsync(
      `skill_id="${this._escape(sid)}" and version=${newVersion} and team_id="${this._escape(tid)}"`,
    );
    if (existing) {
      // 同一版本已存在 → 幂等返回
      return existing;
    }

    const ownerForRow = head ? head.owner_agent_id : (input.owner_agent_id ?? "default");
    const userIdForRow = input.user_id ?? "default";
    const ts = this.now();
    const rowId = this.ulid();
    const storageDir = `skills/${sid}/v${newVersion}`;

    // 4. 构建新行文档
    const doc: Record<string, unknown> = {
      id: rowId,
      skill_id: sid,
      version: newVersion,
      is_head: 1,
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
    };

    // 5. BM25 稀疏向量编码
    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([input.content]);
      if (sparse.length > 0 && sparse[0] && sparse[0].length > 0) {
        doc[SPARSE_VECTOR_FIELD] = sparse[0];
      }
    }

    // 6. 先 INSERT 新行 (补偿 VDB 无事务：新行先落，旧行后翻)
    await this.client.upsert(this.skillsCollection, [doc]);

    // 7. CAS 翻旧 head —— 修 2026-09-02 的并发写脏事故。
    //
    // 原实现是"读→合并→再 upsert"三步, 中间没锁 —— 单个 extract task 内 LLM 通过
    // Vercel AI SDK 一次 turn 并发 skill_patch(expected_version=N) N 份, 全都读到
    // head=vN、全都通过内存 assertVersionFresh、全都到达步骤 6 落新行, 结果 5 行
    // (skill_id, version=N+1, is_head=1) 一起活着, listSkills(is_head=1) 之后返回
    // 同一 skill_id N 次。
    //
    // 现在改成 VDB /document/update 的服务器侧原子 CAS: filter 精确指定"我期望的
    // 旧 head"(skill_id + team_id + version=old + is_head=1), 只有第一个到达的
    // writer 拿到 affectedCount=1, 后到的全部拿 affectedCount=0。后者是 loser,
    // 立刻 DELETE 步骤 6 刚落下的孤儿新行以还原状态, 并抛 SKILL_VERSION_STALE 让
    // 上层调用方(skill-versioning 会同时清 COS 目录)与 LLM(拿到错误后携新版本号
    // 重试)按乐观锁语义处理。
    if (head) {
      let affected = 0;
      try {
        affected = await this.client.update(this.skillsCollection, {
          filter:
            `skill_id="${this._escape(sid)}" and team_id="${this._escape(tid)}" ` +
            `and version=${head.version} and is_head=1`,
          update: { is_head: 0 },
        });
      } catch (err) {
        // 网络/VDB 抖动导致 CAS 状态不明 —— 不能贸然当 loser 删自己(万一 CAS 实际
        // 成功了呢), 也不能贸然当 winner(万一别人先赢了呢)。保留原行为: 记 warn,
        // 让写路径正常返回, 双 head 由 listSkills 的 version DESC 兜底解决。
        this.logger?.warn(
          `${TAG} Head-flip CAS request failed for ${sid} v${head.version}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return this._docToSkill(doc);
      }

      if (affected === 0) {
        // loser 分支: 我们输了 CAS。步骤 6 刚落下的 v=(head+1) 是"孤儿", 必须清掉
        // 才能让 listSkills 保持单一 head。DELETE 用 documentIds 走主键定位, 精确
        // 只删自己那一行, 不会误伤并发 winner 的同版本兄弟行。
        try {
          await this.client.deleteDoc(this.skillsCollection, {
            query: { documentIds: [rowId] },
          });
        } catch (delErr) {
          // 清孤儿失败: 场上会短暂多一行 v=(head+1) 是 is_head=1, 但因为它比 winner
          // 的时间戳更早, listSkills 按 updated_at_ms DESC 会取到 winner。留 warn,
          // 供运维/reconciler 兜底真删。
          this.logger?.warn(
            `${TAG} Head-flip CAS lost race for ${sid} v${newVersion}, but orphan cleanup failed: ` +
              (delErr instanceof Error ? delErr.message : String(delErr)),
          );
        }
        throw new SkillStoreError(
          "SKILL_VERSION_STALE",
          `head advanced under append(skill_id=${sid}, expected_head_version=${head.version})`,
        );
      }
    }

    return this._docToSkill(doc);
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

    return this._queryOneAsync(filter);
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    await this._ensureInit();
    if (this.degraded) return { archived: false };

    const head = await this._getHeadAsync(skillId, teamId);
    if (!head) return { archived: false };

    try {
      await this._updateDocAsync(head.row_id, {
        status: "archived",
        updated_at_ms: this.now(),
      } as Record<string, unknown>);
      return { archived: true };
    } catch (err) {
      this.logger?.warn(`${TAG} archiveHead failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
      return { archived: false };
    }
  }

  // ── ISkillStore: 查询 ─────────────────────────────────────────────────

  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    await this._ensureInit();
    if (this.degraded) return { items: [], total: 0 };

    const conditions: string[] = ["is_head=1"];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.owner_agent_id) conditions.push(`owner_agent_id="${this._escape(opts.owner_agent_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);

    const statuses = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    if (statuses.length === 1) {
      conditions.push(`status="${this._escape(statuses[0])}"`);
    } else {
      // VDB 不支持 `IN (...)` 语法，只支持 `OR`；用 `(status="a" or status="b")` 展开。
      // 之前用 IN 会静默失败（VDB 返回 code=14000），导致 status=["active","archived"] 空结果。
      conditions.push(
        `(${statuses.map((s) => `status="${this._escape(s)}"`).join(" or ")})`,
      );
    }

    const filter = conditions.join(" and ");
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    // name_prefix: VDB filter 语法不支持 LIKE / 字符串前缀匹配，
    // 改为拉取符合其余条件的 head 行后在内存里做前缀过滤再分页。
    // (head 行数量级小，一次性拉取上限 1000 可接受)
    if (opts.name_prefix) {
      const prefix = opts.name_prefix;
      try {
        const resp = await this.client.query(this.skillsCollection, {
          filter,
          limit: 1000,
          outputFields: SKILL_OUTPUT_FIELDS,
          sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
        });
        const filtered = (resp.documents ?? [])
          .map((d) => this._docToSkill(d))
          .filter((s) => s.name.startsWith(prefix));
        // 2026-09-02 auto-heal: 前缀过滤完再 dedup, 保证 UI 只看到 winner
        const deduped = this._autoHealListSkills(filtered);
        return { items: deduped.slice(offset, offset + limit), total: deduped.length };
      } catch (err) {
        this.logger?.warn(`${TAG} listSkills(name_prefix) query failed: ${err instanceof Error ? err.message : String(err)}`);
        return { items: [], total: 0 };
      }
    }

    let total: number;
    try {
      total = await this.client.count(this.skillsCollection, filter);
    } catch {
      total = 0;
    }

    let rows: Skill[] = [];
    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit,
        offset,
        outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
      });
      rows = (resp.documents ?? []).map((d) => this._docToSkill(d));
    } catch (err) {
      this.logger?.warn(`${TAG} listSkills query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2026-09-02 auto-heal: 应用层 group-by skill_id 挑 winner + fire-and-forget
    // demote loser。历史脏数据 (同一 skill_id 多行 is_head=1) 在 UI 一次刷新就自愈。
    // 详见 _autoHealListSkills 注释。
    const deduped = this._autoHealListSkills(rows);
    // total 修正: 本页物理行 - 本页去掉的 loser 数。分页跨脏组时略偏, fire-and-forget
    // 完成 + VDB filter 索引刷新后下次读自动收敛。
    const adjustedTotal = Math.max(0, total - (rows.length - deduped.length));
    return { items: deduped, total: adjustedTotal };
  }

  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const filter = this._buildSearchFilter(opts);
    const mode = opts.mode ?? "bm25";

    try {
      if (mode === "hybrid" && this.bm25Encoder) {
        return this._searchHybridAsync(opts.query, topK, filter);
      }
      if (mode === "embedding") {
        return this._searchEmbeddingAsync(opts.query, topK, filter);
      }
      // bm25 (default)
      return this._searchBm25Async(opts.query, topK, filter);
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

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit,
        offset,
        outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "version", direction: "desc" }],
      });
      return (resp.documents ?? []).map((d) => this._docToSkill(d));
    } catch (err) {
      this.logger?.warn(`${TAG} listVersions query failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}"`;

    try {
      return await this.client.count(this.skillsCollection, filter);
    } catch {
      return 0;
    }
  }

  // ── ISkillStore: TTL Cleanup ─────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter: `is_head=0 and status="active" and created_at_ms<${cutoffMs}`,
        limit: 10000,
        outputFields: ["skill_id", "version", "is_head", "status", "storage_dir", "created_at_ms"],
        // VDB 要求 sort 字段为 uint64；skill_id 是 string 不可排序（code 15143）。
        // 用 created_at_ms 升序（先清最老的），符合 TTL 清理语义。
        sort: [{ fieldName: "created_at_ms", direction: "asc" }],
      });
      return (resp.documents ?? []).map((d) => ({
        skill_id: d.skill_id as string,
        version: d.version as number,
        is_head: (d.is_head as number) === 1,
        status: d.status as SkillStatus,
        storage_dir: d.storage_dir as string,
        created_at_ms: d.created_at_ms as number,
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} findExpiredVersions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    await this._ensureInit();
    if (this.degraded) return false;

    try {
      const filter = `skill_id="${this._escape(skillId)}" and version=${version} and is_head=0`;
      const affected = await this.client.deleteDoc(this.skillsCollection, { query: { filter } });
      return affected > 0;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteVersion failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 物理删除同 skill_id 下的所有版本行。`SkillCore.delete` 走此路径。
   * 权限校验由调用方 SkillCore 负责；本方法只按 (skill_id, team_id) 一次 deleteDoc。
   */
  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;

    try {
      const filter = teamId
        ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
        : `skill_id="${this._escape(skillId)}"`;
      const affected = await this.client.deleteDoc(this.skillsCollection, { query: { filter } });
      return affected;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteAllVersions failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
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
   * 2026-09-02 read-time auto-heal: 从 limit=1 提升到 100, 侦测同一 skill_id
   * 多 head 脏数据 (append-race 遗留), 应用层挑 winner + fire-and-forget demote
   * 其他 loser。参见 _pickHeadAndAutoHeal 注释。
   */
  private async _getHeadAsync(
    skillId: string,
    teamId?: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Skill | null> {
    const statusClause = opts?.includeArchived ? "" : ' and status="active"';
    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}" and is_head=1${statusClause}`
      : `skill_id="${this._escape(skillId)}" and is_head=1${statusClause}`;

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        // clean skill 只有 1 行；脏 skill 生产实际观察最大 5 行，100 是防御性上限。
        // 顺带保证下面 tiebreaker 在极端脏数据下仍有确定 winner。
        limit: 100,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      const rows = (resp.documents ?? []).map((d) => this._docToSkill(d));
      return this._pickHeadAndAutoHeal(rows);
    } catch (err) {
      this.logger?.warn(`${TAG} getHead failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }


  // ─── Read-time auto-heal (2026-09-02) ────────────────────────────────
  // 处理"同 skill_id 多 head is_head=1"的历史脏数据（append-race 遗留）。
  // 每次读 head / list 时侦测 + 挑 winner + fire-and-forget demote loser。
  // - winner 选择完全确定性: version DESC → updated_at_ms DESC → row_id ASC。
  //   最后一层 row_id 保证并发 reader 挑同一个 winner, 彼此的 demote 集合
  //   不打架, 收敛无歧义。
  // - demote 走 documentIds 精确定位, 不受 filter 表达式在时间戳并列 / VDB
  //   filter-index 异步刷新的影响。
  // - 失败(网络/VDB 抖动)只 warn, 主流程返回 winner 不受阻; 下次读会再检测
  //   再尝试, 幂等收敛。
  //
  // TTL 兜底: loser 变成 (v=N, is_head=0), 后续版本推进 → v=N 落出
  // KEEP_RECENT 保护窗 + 时间过 cutoff 时, deleteVersion(sid, N) 一次性删掉
  // 所有 (skill_id=X, version=N, is_head=0) 行(winner 那时也已 demote), 彻底
  // 收敛。极端场景 (skill 从此不动) loser 停在磁盘上, 但不进任何读视图。

  /**
   * 从 is_head=1 候选行里挑 winner, 并 fire-and-forget demote 其他行。
   * 输入通常来自 filter 为 `is_head=1 and ...` 的 query 结果。
   * 空输入返回 null; 单行输入直接返回, 不触发 update。
   */
  private _pickHeadAndAutoHeal(rows: Skill[]): Skill | null {
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0];

    const sorted = [...rows].sort((a, b) => {
      if (a.version !== b.version) return b.version - a.version;
      if (a.updated_at_ms !== b.updated_at_ms) return b.updated_at_ms - a.updated_at_ms;
      return a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0;
    });
    const winner = sorted[0]!;
    const loserRowIds = sorted.slice(1).map((r) => r.row_id).filter((id) => !!id);

    this.logger?.warn(
      `${TAG} dirty-head auto-heal: skill_id=${winner.skill_id} keeps row_id=${winner.row_id} ` +
        `v${winner.version} ts=${winner.updated_at_ms}, demoting ${loserRowIds.length} loser(s)`,
    );

    if (loserRowIds.length > 0) {
      // fire-and-forget: 主读路径不等 demote 完成; 失败只 warn, 下次读再补。
      this.client
        .update(this.skillsCollection, {
          documentIds: loserRowIds,
          update: { is_head: 0 },
        })
        .catch((err) => {
          this.logger?.warn(
            `${TAG} auto-heal demote failed for skill_id=${winner.skill_id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
    }

    return winner;
  }

  /**
   * 对 listSkills 结果做 group-by skill_id + 每组挑 winner。
   * 供 listSkills 修正返回 items 与 total 用。
   */
  private _autoHealListSkills(rows: Skill[]): Skill[] {
    if (rows.length <= 1) return rows;
    const grouped = new Map<string, Skill[]>();
    for (const r of rows) {
      const arr = grouped.get(r.skill_id);
      if (arr) arr.push(r);
      else grouped.set(r.skill_id, [r]);
    }
    // 快速路径: 完全 clean 时避免多余循环
    if (grouped.size === rows.length) return rows;

    const winners: Skill[] = [];
    for (const group of grouped.values()) {
      const w = this._pickHeadAndAutoHeal(group);
      if (w) winners.push(w);
    }
    return winners;
  }

  /** 按 filter 取一条 */
  private async _queryOneAsync(filter: string): Promise<Skill | null> {
    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit: 1,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      return resp.documents && resp.documents.length > 0
        ? this._docToSkill(resp.documents[0])
        : null;
    } catch (err) {
      this.logger?.warn(`${TAG} queryOne failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
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

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit: 1,
        outputFields: ["skill_id"],
      });
      if (resp.documents && resp.documents.length > 0) {
        const dupId = resp.documents[0].skill_id as string;
        if (dupId !== excludeSkillId) {
          throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${name}' already exists for agent in team`);
        }
      }
    } catch (err) {
      if (err instanceof SkillStoreError) throw err;
      this.logger?.warn(`${TAG} name uniqueness check failed: ${err instanceof Error ? err.message : String(err)}`);
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
        limit: topK * 2,
      }],
      match: [{
        fieldName: SPARSE_VECTOR_FIELD,
        data: [sparseVec],
        limit: topK * 2,
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
