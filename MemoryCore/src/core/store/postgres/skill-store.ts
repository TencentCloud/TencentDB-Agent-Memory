/**
 * PgSkillStore — Skill 数据访问层的 PostgreSQL 实现。
 *
 * [pg-align] 2026-09-13 新增：与 SqliteSkillStore 语义 1:1 对齐，
 * 供 storeBackend=postgres 的 PgMemoryStore 通过 getPgPool() 逃生舱接入。
 *
 * 与 SQLite 版的差异（其余语义完全一致）：
 *   - FTS5 → skills.fts_segmented（jieba 预分词）+ fts_tsv 生成列 + GIN。
 *     生成列随行更新自动维护，无需 SQLite 版的"删旧行/插新行"同步。
 *   - vec0 → 独立表 skill_vec(skill_id PK, embedding vector(dim)) + ivfflat cosine。
 *   - 事务：SQLite 用 BEGIN IMMEDIATE 全库串行；PG 用事务级 advisory lock
 *     （pg_advisory_xact_lock(hashtext(skill_id))）按 skill_id 串行 appendVersion。
 *   - created_at_ms / updated_at_ms 用 BIGINT（Date.now() 超 int4），读回 Number()。
 *   - init() 为异步 DDL 的同步 kickoff（接口签名是 void）；所有方法内部
 *     await this.readyPromise，DDL 完成前请求会排队而非报错。
 *   - 额外实现 embedding / hybrid(RRF) 检索路径（SQLite 版仅 BM25）。
 *
 * 表结构见 init() 内 DDL；语义基准见 store/sqlite/skill-store.ts 与
 * docs/design/2026-06-17-skill-redesign-v2.md §2 / §5。
 */

import type { Pool } from "pg";

import { randomBase62 } from "../../../utils/short-id.js";
import { tokenizeForFts } from "../tokenize.js";
import { FTS_CONTENT_MAX } from "../../skill/skill-store-ddl.js";
import type {
  ISkillStore,
  ExpiredVersionMeta,
  SkillStoreCapabilities,
  SkillSearchResult,
} from "../../skill/skill-store.interface.js";
import { SkillStoreError } from "../../skill/skill-store.interface.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  SkillManifestEntry,
  SkillStatus,
  Skill,
} from "../../skill/types.js";

// ═══════════════════════════════════════════════════════════════════════
//  Logger / Options
// ═══════════════════════════════════════════════════════════════════════

export interface StoreLogger {
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PgSkillStoreOptions {
  pool: Pool;
  /** Embedding 维度。0 = 不创建 skill_vec 表。 */
  dimensions: number;
  logger?: StoreLogger;
  /**
   * 可选文本嵌入函数（由 skill wiring 注入，对齐 TCVDB 后端的服务端
   * embedding 语义）。未注入（provider 未配置）时检索降级 bm25，与
   * SQLite/MongoDB 后端行为一致。写入侧：appendVersion 后 fire-and-forget
   * 重算 head 向量；查询侧：embedding/hybrid 模式就地计算 queryEmbedding。
   */
  embed?: (text: string) => Promise<Float32Array>;
  /** 注入的 now（毫秒）。默认 Date.now。便于测试。 */
  now?: () => number;
  /** 注入的 row_id 生成器。默认见 defaultUlid()。便于测试。 */
  ulid?: () => string;
}

// ═══════════════════════════════════════════════════════════════════════
//  内部辅助
// ═══════════════════════════════════════════════════════════════════════

function defaultUlid(): string {
  return randomBase62(12);
}

interface SkillRowRaw {
  row_id: string;
  skill_id: string;
  version: number | string;
  is_head: number | string | boolean;

  user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest_json: string;
  storage_dir: string;

  status: string;
  metadata_json: string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
}

function toSkill(raw: SkillRowRaw): Skill {
  let manifest: SkillManifestEntry[];
  try {
    manifest = JSON.parse(raw.manifest_json);
    if (!Array.isArray(manifest)) manifest = [];
  } catch {
    manifest = [];
  }
  return {
    row_id: raw.row_id,
    skill_id: raw.skill_id,
    version: Number(raw.version),
    is_head: Number(raw.is_head) === 1,
    user_id: raw.user_id,
    owner_agent_id: raw.owner_agent_id,
    team_id: raw.team_id,
    task_id: raw.task_id,
    name: raw.name,
    description: raw.description,
    content: raw.content,
    content_hash: raw.content_hash,
    manifest,
    storage_dir: raw.storage_dir,
    status: raw.status as SkillStatus,
    metadata_json: raw.metadata_json,
    created_at_ms: Number(raw.created_at_ms),
    updated_at_ms: Number(raw.updated_at_ms),
  };
}

function float32ToPgVector(arr: Float32Array): string {
  return "[" + Array.from(arr).join(",") + "]";
}

/** jieba 预分词 → websearch_to_tsquery 语法（token 间 OR，去引号防语法注入）。 */
function buildWebsearchQuery(query: string): string {
  const segmented = tokenizeForFts(query);
  const tokens = segmented
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter(Boolean);
  return tokens.join(" OR ");
}

// ═══════════════════════════════════════════════════════════════════════
//  Store 实现
// ═══════════════════════════════════════════════════════════════════════

export class PgSkillStore implements ISkillStore {
  private readonly pool: Pool;
  private readonly dimensions: number;
  private readonly logger?: StoreLogger;
  private readonly embedFn?: (text: string) => Promise<Float32Array>;
  private readonly now: () => number;
  private readonly ulid: () => string;
  private vecAvailable = false;
  private degraded = false;
  private initPromise: Promise<void>;

  constructor(opts: PgSkillStoreOptions) {
    this.pool = opts.pool;
    this.dimensions = Math.max(0, Math.floor(opts.dimensions ?? 0));
    this.logger = opts.logger;
    this.embedFn = opts.embed;
    this.now = opts.now ?? (() => Date.now());
    this.ulid = opts.ulid ?? defaultUlid;
    this.initPromise = this.runDdl();
  }

  /**
   * 建表与索引（幂等）。由构造函数自动触发；接口签名保持 void。
   * 失败不抛出（避免阻断 gateway 启动）——置 degraded 并 warn，
   * 后续所有操作返回空结果，与 SQLite 版 FTS 失败降级思路一致。
   */
  init(): void {
    // DDL 已在构造函数中 kickoff；这里只做幂等触发（initPromise 已 settled 则跳过）。
    void this.initPromise;
  }

  private async runDdl(): Promise<void> {
    try {
      // ── skills 主表（对应 SKILLS_DDL；BIGINT 存毫秒时间戳）──
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS skills (
          row_id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          is_head INTEGER NOT NULL DEFAULT 1,
          user_id TEXT NOT NULL,
          owner_agent_id TEXT NOT NULL,
          team_id TEXT NOT NULL,
          task_id TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          manifest_json TEXT NOT NULL DEFAULT '[]',
          storage_dir TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at_ms BIGINT NOT NULL,
          updated_at_ms BIGINT NOT NULL,
          fts_segmented TEXT NOT NULL DEFAULT '',
          fts_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(fts_segmented, ''))) STORED,
          UNIQUE(skill_id, version)
        )`);
      // 迁移：删除旧版 (team_id, name) 唯一索引（与 SQLite 版 migrateFtsSchema 同源）
      await this.pool.query("DROP INDEX IF EXISTS uniq_skills_team_name_head").catch(() => {});
      await this.pool.query(
        "CREATE UNIQUE INDEX IF NOT EXISTS uniq_skills_team_agent_name_head ON skills(team_id, owner_agent_id, name) WHERE is_head=1 AND status='active'",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS idx_skills_team_head ON skills(team_id, is_head, status)",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS idx_skills_owner_head ON skills(owner_agent_id, is_head, status)",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, is_head)",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS idx_skills_skill_version ON skills(skill_id, version DESC)",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS idx_skills_task_audit ON skills(task_id, created_at_ms DESC)",
      );
      await this.pool.query(
        "CREATE INDEX IF NOT EXISTS idx_skills_fts ON skills USING GIN (fts_tsv)",
      );

      // ── skill_vec（对应 SKILL_VEC_DDL_TEMPLATE）──
      if (this.dimensions > 0) {
        try {
          await this.pool.query(
            `CREATE TABLE IF NOT EXISTS skill_vec (
               skill_id TEXT PRIMARY KEY,
               embedding vector(${this.dimensions})
             )`,
          );
          await this.pool.query(
            "CREATE INDEX IF NOT EXISTS idx_skill_vec_embedding ON skill_vec USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)",
          );
          this.vecAvailable = true;
        } catch (e) {
          this.logger?.warn(
            `[pg-skill-store] skill_vec init failed: ${(e as Error).message}; downgrade to bm25-only`,
          );
          this.vecAvailable = false;
        }
      }

      this.logger?.info(
        `[pg-skill-store] DDL ready (vec=${this.vecAvailable}, dims=${this.dimensions})`,
      );
    } catch (e) {
      this.degraded = true;
      this.logger?.error(`[pg-skill-store] DDL failed (degraded mode): ${(e as Error).message}`);
    }
  }

  private async ready(): Promise<boolean> {
    try {
      await this.initPromise;
    } catch {
      this.degraded = true;
    }
    return !this.degraded;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: this.vecAvailable,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  /** 关闭 store（连接由 PgMemoryStore 外部管理，不 end pool）。 */
  close(): void {
    this.degraded = true;
  }

  // ────────────────────────────────────────────────────────────────────
  //  appendVersion（与 SqliteSkillStore 相同的四步语义：
  //  重名检查 / name 不可变 / 旧 head 翻 0 / 插入新行）
  // ────────────────────────────────────────────────────────────────────
  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    if (!(await this.ready())) throw new SkillStoreError("SKILL_NOT_FOUND", "store degraded");
    const tid = input.team_id ?? "default";

    const client = await this.pool.connect();
    let newRowId = "";
    try {
      await client.query("BEGIN");
      // 事务级 advisory lock：按 skill_id 串行化并发 appendVersion
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.skill_id]);

      // [1] 当前 head（active-only，与 getHead 语义一致）
      const headRes = await client.query(
        "SELECT * FROM skills WHERE skill_id=$1 AND team_id=$2 AND is_head=1 AND status='active' LIMIT 1",
        [input.skill_id, tid],
      );
      const headRaw = (headRes.rows[0] ?? undefined) as SkillRowRaw | undefined;

      // [2] 重名 / name 不可变检查
      if (!headRaw) {
        const oid = input.owner_agent_id ?? "default";
        const dupRes = await client.query(
          "SELECT 1 FROM skills WHERE team_id=$1 AND owner_agent_id=$2 AND name=$3 AND is_head=1 AND status='active' LIMIT 1",
          [tid, oid, input.name],
        );
        if (dupRes.rows.length > 0) {
          await client.query("ROLLBACK");
          throw new SkillStoreError(
            "SKILL_NAME_DUPLICATE",
            `name '${input.name}' already exists for agent in team`,
          );
        }
      } else {
        if (headRaw.name !== input.name) {
          await client.query("ROLLBACK");
          throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
        }
      }

      const newVersion = headRaw ? Number(headRaw.version) + 1 : 1;
      const ownerForRow = headRaw ? headRaw.owner_agent_id : (input.owner_agent_id ?? "default");
      // user_id 记录的是本次操作者，而非首次创建者。后续版本取 input.user_id。
      const userIdForRow = input.user_id ?? "default";
      const ts = this.now();
      newRowId = this.ulid();

      const ftsContent = input.content.length > FTS_CONTENT_MAX
        ? input.content.slice(0, FTS_CONTENT_MAX)
        : input.content;
      const ftsSegmented = [
        tokenizeForFts(input.name),
        tokenizeForFts(input.description ?? ""),
        tokenizeForFts(ftsContent),
      ]
        .filter(Boolean)
        .join(" ");

      // [3] 旧 head 翻 0 → [4] 插入新行（fts_tsv 生成列自动维护，无需手工同步）
      if (headRaw) {
        await client.query(
          "UPDATE skills SET is_head=0 WHERE skill_id=$1 AND version=$2",
          [headRaw.skill_id, Number(headRaw.version)],
        );
      }
      await client.query(
        `INSERT INTO skills (
           row_id, skill_id, version, is_head,
           user_id, owner_agent_id, team_id, task_id,
           name, description, content, content_hash, manifest_json, storage_dir,
           status, metadata_json, created_at_ms, updated_at_ms, fts_segmented
         ) VALUES ($1,$2,$3,$4, $5,$6,$7,$8, $9,$10,$11,$12,$13,$14, $15,$16,$17,$18,$19)`,
        [
          newRowId,
          input.skill_id,
          newVersion,
          1,
          userIdForRow,
          ownerForRow,
          tid,
          input.task_id ?? "default",
          input.name,
          input.description,
          input.content,
          input.content_hash,
          JSON.stringify(input.manifest ?? []),
          input.storage_dir,
          "active",
          input.metadata_json ?? "{}",
          ts,
          ts,
          ftsSegmented,
        ],
      );

      // 版本翻新后旧 embedding 即过期（无写入方时为 no-op，纯防御）
      if (this.vecAvailable) {
        await client.query("DELETE FROM skill_vec WHERE skill_id=$1", [input.skill_id]).catch(() => {});
      }

      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }

    // 取回新行（事务外读取，节省持锁时间）
    const inserted = await this.pool.query("SELECT * FROM skills WHERE row_id=$1", [newRowId]);
    const raw = inserted.rows[0] as SkillRowRaw | undefined;
    if (!raw) throw new SkillStoreError("SKILL_NOT_FOUND", "inserted row vanished");
    // 写入侧接线：head 内容已提交，异步重算向量（fire-and-forget，失败只 warn
    // 不影响写入结果）。旧向量已在事务内清除（见上 DELETE FROM skill_vec）。
    if (this.vecAvailable && this.embedFn) {
      void this.reembedHead(input.skill_id, input.name, input.description, input.content);
    }
    return toSkill(raw);
  }

  // ────────────────────────────────────────────────────────────────────
  //  archiveHead（幂等；archived 后不可搜索）
  // ────────────────────────────────────────────────────────────────────
  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    if (!(await this.ready())) return { archived: false };
    const where = teamId ? "skill_id=$1 AND team_id=$2 AND is_head=1" : "skill_id=$1 AND is_head=1";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = await this.pool.query(
      `UPDATE skills SET status='archived', updated_at_ms=$${args.length + 1} WHERE ${where}`,
      [...args, this.now()],
    );
    if (r.rowCount && r.rowCount > 0) return { archived: true };

    // 检查是否之前已 archived（仍算成功 / 幂等）
    const checkWhere = teamId
      ? "skill_id=$1 AND team_id=$2 AND is_head=1 AND status='archived'"
      : "skill_id=$1 AND is_head=1 AND status='archived'";
    const exists = await this.pool.query(`SELECT 1 FROM skills WHERE ${checkWhere} LIMIT 1`, args);
    return { archived: exists.rows.length > 0 };
  }

  // ────────────────────────────────────────────────────────────────────
  //  getHead / getByVersion / listVersions
  // ────────────────────────────────────────────────────────────────────
  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    if (!(await this.ready())) return null;
    const where = teamId ? "skill_id=$1 AND team_id=$2" : "skill_id=$1";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = await this.pool.query(
      `SELECT * FROM skills WHERE ${where} AND is_head=1 AND status='active' LIMIT 1`,
      args,
    );
    const raw = r.rows[0] as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    if (!(await this.ready())) return null;
    const where = teamId ? "skill_id=$1 AND team_id=$2" : "skill_id=$1";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = await this.pool.query(
      `SELECT * FROM skills WHERE ${where} AND is_head=1 LIMIT 1`,
      args,
    );
    const raw = r.rows[0] as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    if (!(await this.ready())) return null;
    const where = teamId ? "skill_id=$1 AND version=$2 AND team_id=$3" : "skill_id=$1 AND version=$2";
    const args: unknown[] = teamId ? [skillId, version, teamId] : [skillId, version];
    const r = await this.pool.query(`SELECT * FROM skills WHERE ${where} LIMIT 1`, args);
    const raw = r.rows[0] as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<Skill[]> {
    if (!(await this.ready())) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = teamId ? "skill_id=$1 AND team_id=$2" : "skill_id=$1";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    args.push(limit, offset);
    const r = await this.pool.query(
      `SELECT * FROM skills WHERE ${where} ORDER BY version DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return (r.rows as SkillRowRaw[]).map(toSkill);
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    if (!(await this.ready())) return 0;
    const where = teamId ? "skill_id=$1 AND team_id=$2" : "skill_id=$1";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = await this.pool.query(`SELECT COUNT(*) AS c FROM skills WHERE ${where}`, args);
    return Number((r.rows[0] as { c: number | string }).c);
  }

  // ────────────────────────────────────────────────────────────────────
  //  listSkills（head + status 过滤 + 四 ID 过滤 + name 前缀 + 分页）
  // ────────────────────────────────────────────────────────────────────
  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    if (!(await this.ready())) return { items: [], total: 0 };
    const status = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where: string[] = ["is_head=1"];
    const args: unknown[] = [];
    const push = (frag: string, val: unknown) => {
      args.push(val);
      where.push(frag.replace("?", `$${args.length}`));
    };

    if (opts.team_id) push("team_id=?", opts.team_id);
    if (opts.owner_agent_id) push("owner_agent_id=?", opts.owner_agent_id);
    if (opts.user_id) push("user_id=?", opts.user_id);
    if (opts.task_id) push("task_id=?", opts.task_id);

    const statusFrags = status.map((s) => {
      args.push(s);
      return `$${args.length}`;
    });
    where.push(`status IN (${statusFrags.join(",")})`);

    if (opts.name_prefix) push("name ILIKE ?", `${opts.name_prefix}%`);

    const whereSql = where.join(" AND ");

    const totalRes = await this.pool.query(
      `SELECT COUNT(*) AS c FROM skills WHERE ${whereSql}`,
      args,
    );
    args.push(limit, offset);
    const rowsRes = await this.pool.query(
      `SELECT * FROM skills WHERE ${whereSql} ORDER BY updated_at_ms DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return {
      items: (rowsRes.rows as SkillRowRaw[]).map(toSkill),
      total: Number((totalRes.rows[0] as { c: number | string }).c),
    };
  }

  // ────────────────────────────────────────────────────────────────────
  //  searchSkills
  //  bm25 = ts_rank；embedding = cosine；hybrid = RRF(k=60) 融合。
  // ────────────────────────────────────────────────────────────────────
  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    if (!(await this.ready())) return [];
    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const query = (opts.query ?? "").trim();
    if (!query) return [];

    const mode = opts.mode ?? "bm25";
    // 查询侧接线：embedding/hybrid 且未显式传 queryEmbedding 时，用注入的
    // embed 函数就地计算（调用方 SkillCore 不感知）。失败仅 warn 并降级 bm25。
    let queryEmbedding = opts.queryEmbedding;
    if ((mode === "embedding" || mode === "hybrid") && !queryEmbedding && this.vecAvailable && this.embedFn) {
      try {
        queryEmbedding = await this.embedFn(query);
      } catch (e) {
        this.logger?.warn(`[pg-skill-store] query embed failed, falling back to bm25: ${(e as Error).message}`);
      }
    }
    if ((mode === "embedding" || mode === "hybrid") && (!this.vecAvailable || !queryEmbedding)) {
      this.logger?.warn(
        `[pg-skill-store] search mode='${mode}' downgraded to 'bm25' ` +
          `(vec_available=${this.vecAvailable}, has_embedding=${!!queryEmbedding})`,
      );
    }
    const useVec =
      (mode === "embedding" || mode === "hybrid") && this.vecAvailable && !!queryEmbedding;

    if (mode === "embedding" && useVec) {
      return this.vectorSearch(opts, queryEmbedding!, topK);
    }
    if (mode === "hybrid" && useVec) {
      const [bm25Hits, vecHits] = await Promise.all([
        this.bm25Search(opts, query, topK),
        this.vectorSearch(opts, queryEmbedding!, topK),
      ]);
      // RRF 融合：score = Σ 1/(60+rank)
      const fused = new Map<string, { skill: Skill; score: number; snippet?: string }>();
      bm25Hits.forEach((h, i) => {
        const cur = fused.get(h.skill.skill_id) ?? { skill: h.skill, score: 0, snippet: h.snippet };
        cur.score += 1 / (60 + i + 1);
        fused.set(h.skill.skill_id, cur);
      });
      vecHits.forEach((h, i) => {
        const cur = fused.get(h.skill.skill_id) ?? { skill: h.skill, score: 0 };
        cur.score += 1 / (60 + i + 1);
        fused.set(h.skill.skill_id, cur);
      });
      return Array.from(fused.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((h) => ({ skill: h.skill, score: h.score, snippet: h.snippet }));
    }
    return this.bm25Search(opts, query, topK);
  }

  private buildSearchFilters(
    opts: SearchSkillsOptions,
    startIdx: number,
  ): { clause: string; params: unknown[] } {
    const frags: string[] = [];
    const params: unknown[] = [];
    let n = startIdx;
    const add = (col: string, val: string | undefined) => {
      if (val) {
        n += 1;
        frags.push(`${col} = $${n}`);
        params.push(val);
      }
    };
    add("s.team_id", opts.team_id);
    add("s.owner_agent_id", opts.agent_id);
    add("s.task_id", opts.task_id);
    add("s.user_id", opts.user_id);
    return { clause: frags.length ? "AND " + frags.join(" AND ") : "", params };
  }

  private async bm25Search(
    opts: SearchSkillsOptions,
    query: string,
    topK: number,
  ): Promise<SkillSearchResult[]> {
    const wsQuery = buildWebsearchQuery(query);
    if (!wsQuery) return [];
    try {
      const flt = this.buildSearchFilters(opts, 1);
      const params: unknown[] = [wsQuery, ...flt.params, topK];
      const r = await this.pool.query(
        `SELECT s.*,
                ts_rank(s.fts_tsv, w.q) AS rank,
                ts_headline('simple', s.fts_segmented, w.q,
                            'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=16') AS snippet
         FROM skills s,
              LATERAL (SELECT websearch_to_tsquery('simple', $1) AS q) w
         WHERE s.fts_tsv @@ w.q AND s.is_head=1 AND s.status='active'
           ${flt.clause}
         ORDER BY rank DESC
         LIMIT $${params.length}`,
        params,
      );
      return (r.rows as Array<SkillRowRaw & { rank: number | string; snippet?: string }>).map(
        (row) => ({
          skill: toSkill(row),
          score: Number(row.rank),
          snippet: row.snippet ?? "",
        }),
      );
    } catch (e) {
      this.logger?.warn(`[pg-skill-store] fts query failed: ${(e as Error).message}`);
      return [];
    }
  }

  private async vectorSearch(
    opts: SearchSkillsOptions,
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<SkillSearchResult[]> {
    try {
      // 注意：过滤器编号必须从 $2 起（与紧凑 params 数组对齐）——历史上这里
      // 传 2 导致 $3/$4 与 LIMIT $4 撞号（PG 把 $4 解析为 text），向量路径
      // 从未跑通过；本次接线时修复。
      const flt = this.buildSearchFilters(opts, 1);
      const vecStr = float32ToPgVector(queryEmbedding);
      const params: unknown[] = [vecStr, ...flt.params, topK];
      const r = await this.pool.query(
        `SELECT s.*, 1 - (v.embedding <=> $1::vector) AS sim
         FROM skill_vec v JOIN skills s ON s.skill_id = v.skill_id
         WHERE s.is_head=1 AND s.status='active'
           ${flt.clause}
         ORDER BY sim DESC
         LIMIT $${params.length}`,
        params,
      );
      return (r.rows as Array<SkillRowRaw & { sim: number | string }>).map((row) => ({
        skill: toSkill(row),
        score: Number(row.sim),
        snippet: "",
      }));
    } catch (e) {
      this.logger?.warn(`[pg-skill-store] vector query failed: ${(e as Error).message}`);
      return [];
    }
  }

  // ────────────────────────────────────────────────────────────────────
  //  TTL 清理
  // ────────────────────────────────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    if (!(await this.ready())) return [];
    const r = await this.pool.query(
      `SELECT skill_id, version, is_head, status, storage_dir, created_at_ms
       FROM skills WHERE is_head=0 AND status='active' AND created_at_ms < $1
       ORDER BY skill_id ASC, version ASC`,
      [cutoffMs],
    );
    return (r.rows as Array<{
      skill_id: string;
      version: number | string;
      is_head: number | string;
      status: string;
      storage_dir: string;
      created_at_ms: number | string;
    }>).map((row) => ({
      skill_id: row.skill_id,
      version: Number(row.version),
      is_head: Number(row.is_head) === 1,
      status: row.status as SkillStatus,
      storage_dir: row.storage_dir,
      created_at_ms: Number(row.created_at_ms),
    }));
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    if (!(await this.ready())) return false;
    const r = await this.pool.query(
      "DELETE FROM skills WHERE skill_id=$1 AND version=$2 AND is_head=0",
      [skillId, version],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    if (!(await this.ready())) return 0;
    const where = teamId ? "skill_id=$1 AND team_id=$2" : "skill_id=$1";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = await this.pool.query(`DELETE FROM skills WHERE ${where}`, args);
    const changes = r.rowCount ?? 0;
    // 仅当主表真的删掉了行时才清附属表 —— 避免跨 team 校验失败时误清 vec
    if (changes > 0) {
      await this.pool.query("DELETE FROM skill_vec WHERE skill_id=$1", [skillId]).catch(() => {});
    }
    return changes;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Embedding 维护（部署侧接线：skill wiring 注入 embed 函数后，
  //  写入侧 appendVersion → reembedHead，查询侧 searchSkills 就地计算，
  //  存量数据由 backfillEmbeddings 兜底 —— 对齐 TCVDB 后端的服务端
  //  embedding 语义；未注入时本组方法全部 no-op，检索降级 bm25。）
  // ────────────────────────────────────────────────────────────────────

  /** 重算某 skill head 版本的向量（文本组成与 ftsSegmented 一致）。失败仅 warn。 */
  private async reembedHead(
    skillId: string,
    name: string,
    description: string | undefined,
    content: string,
  ): Promise<void> {
    if (!this.embedFn) return;
    try {
      // 截断由 EmbeddingService 内部处理（local 512 字符 / remote maxInputChars）
      const text = `${name}\n${description ?? ""}\n${content}`;
      const vec = await this.embedFn(text);
      await this.upsertEmbedding(skillId, vec);
    } catch (e) {
      this.logger?.warn(`[pg-skill-store] reembedHead(${skillId}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * 存量回填：为没有向量的 active head skill 补算 embedding（升级部署时，
   * 老数据在启动后异步获得向量检索能力）。串行、有界、幂等。
   */
  async backfillEmbeddings(limit = 100): Promise<number> {
    if (!this.embedFn || !(await this.ready()) || !this.vecAvailable) return 0;
    try {
      const r = await this.pool.query(
        `SELECT s.skill_id, s.name, s.description, s.content
         FROM skills s LEFT JOIN skill_vec v ON v.skill_id = s.skill_id
         WHERE s.is_head=1 AND s.status='active' AND v.skill_id IS NULL
         LIMIT $1`,
        [Math.max(1, Math.floor(limit))],
      );
      const rows = r.rows as Array<{ skill_id: string; name: string; description: string | null; content: string }>;
      for (const row of rows) {
        await this.reembedHead(row.skill_id, row.name, row.description ?? undefined, row.content);
      }
      if (rows.length > 0) {
        this.logger?.info(`[pg-skill-store] backfilled embeddings for ${rows.length} skill(s)`);
      }
      return rows.length;
    } catch (e) {
      this.logger?.warn(`[pg-skill-store] backfillEmbeddings failed: ${(e as Error).message}`);
      return 0;
    }
  }

  async upsertEmbedding(skillId: string, embedding: Float32Array): Promise<void> {
    if (!(await this.ready()) || !this.vecAvailable) return;
    if (embedding.length !== this.dimensions) {
      this.logger?.warn(
        `[pg-skill-store] embedding dim mismatch: ${embedding.length} vs ${this.dimensions}`,
      );
      return;
    }
    try {
      await this.pool.query(
        `INSERT INTO skill_vec (skill_id, embedding) VALUES ($1, $2::vector)
         ON CONFLICT (skill_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
        [skillId, float32ToPgVector(embedding)],
      );
    } catch (e) {
      this.logger?.warn(`[pg-skill-store] upsertEmbedding failed: ${(e as Error).message}`);
    }
  }

  async deleteEmbedding(skillId: string): Promise<void> {
    if (!(await this.ready()) || !this.vecAvailable) return;
    try {
      await this.pool.query("DELETE FROM skill_vec WHERE skill_id=$1", [skillId]);
    } catch (e) {
      this.logger?.warn(`[pg-skill-store] deleteEmbedding failed: ${(e as Error).message}`);
    }
  }
}
