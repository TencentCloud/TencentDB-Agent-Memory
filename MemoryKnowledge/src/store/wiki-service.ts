/**
 * WikiService — wiki 资产的异步编排（与 CodeGraphService 对称）。
 *
 * IKnowledgeStore（元数据/状态）+ BuildQueue（后台串行）+ 可注入 worker
 * （实际 ingest / 建索引）。状态机：pending → processing(scanning/ingesting)
 * → ready / failed(+sync_error)。memory + team 隔离、幂等（同 memory+team+name 返回已存在）、
 * 软删 + 清目录。物理目录 {dataRoot}/{service_id}/{team_id}/{wiki_id}/（001 多租户）。
 *
 * 文件层（11 文档定稿）：raw / page 各一套 ls/read/write/rm，对齐 L2 Scenario。
 * - raw/* 仅操作 raw/sources/，不触发 ingest。
 * - page/* 操作 wiki/，写入自动注入 frontmatter `locked: true`，删除调
 *   lib 层 cascadeDeleteWikiPagesWithRefs 做引用级联。
 */

import { join, resolve, normalize, dirname } from "node:path";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import type {
  AuditAction,
  IKnowledgeStore,
  WikiRow,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import {
  initIndexDb,
  withWriteDb,
  getReadDb,
  evictWikiDb,
  upsertSource,
  listSources,
  deleteSources,
  sha256,
  type SourceStatus,
} from "../engines/wiki/index-db.js";

export interface WikiBuildContext {
  wikiId: string;
  serviceId: string;
  teamId: string;
  name: string;
  dir: string;
  setInternalStatus: (s: string) => void;
  /** 单次 ingest 代际；进度/终态 callback 共用，防 Panel 迟到包 */
  ingestRunId: string;
}

export interface WikiBuildResult {
  pageCount?: number;
}

export type WikiWorker = (ctx: WikiBuildContext) => Promise<WikiBuildResult | void>;

/**
 * ingest 结果（判别联合）：
 *   - ok       已入队重建（无在途任务）；
 *   - queued   已在途，按 onBusy:'replace' 取消旧任务后排队新任务（设计 2026-09-21 §3.3）；
 *   - not_found memory/team/id 不匹配；
 *   - busy     正在 pending/processing 且 onBusy:'reject'（并发拒绝，对应 HTTP 409），
 *              step 为内部阶段（可 null）。
 */
export type IngestResult =
  | { kind: "ok"; row: WikiRow }
  | { kind: "queued"; row: WikiRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

/**
 * ingest 行为选项（设计 2026-09-21 §3.3）。
 * onBusy 仅在 wiki 已有在途任务（status ∈ {pending, processing}）时生效：
 *   - 'reject'（默认）：拒绝，返回 busy（原语义，自动同步/CLI/sync 别名保持不变）；
 *   - 'replace'：置 cancelled 标记 + internal_status='cancelling'，并把新任务
 *     排入 SerialQueue（FIFO）。旧 worker 返回后由检查点做 preserveRaw 收尾。
 */
export interface IngestOptions {
  onBusy?: "reject" | "replace";
}

export interface WikiServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WikiServiceOptions {
  store: IKnowledgeStore;
  dataRoot: string;
  worker: WikiWorker;
  queue?: BuildQueue;
  logger?: WikiServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: {
    tmcCallbackUrl: string;
    /** Per-instance LLM resolver for summary generation (keyed by service_id). */
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
}

export interface CreateWikiParams {
  service_id: string;
  team_id: string;
  name: string;
  source_type?: string;
  source_url?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

// ── 文件层 result 类型（对齐 yaml schema） ──

export interface RawFileEntry {
  filename: string;
  size: number;
  /** 源文件生命周期状态（uploaded/ingested/failed，设计 003）。 */
  status: SourceStatus;
  /** 首次上传时间（此后不变）。 */
  created_at: string;
  /** 最近一次内容变更时间。 */
  updated_at: string;
  /** 最后变更人 user_id（无历史流水）。 */
  last_modified_by: string | null;
  /** 最近成功抽取时间（未抽为 null）。 */
  ingested_at: string | null;
  /** @deprecated 兼容旧字段，等于 created_at。 */
  uploaded_at: string;
}

export interface RawWriteResult {
  filename: string;
  size: number;
}

export interface RawReadItem {
  filename: string;
  content?: string;
  not_found?: boolean;
}

export interface RawWriteManyItem {
  filename: string;
  size: number;
}

export interface RawRmResult {
  deleted_files: string[];
  deleted_pages: string[];
  rewritten_pages: number;
}

/**
 * 导入文件名映射文件结构（`<wikiDir>/import-map.json`）。
 * providerId → (externalId → 落盘文件名)。
 * 兼容两种值形态：字符串（当前写入形式）或 { filename }（历史/未来扩展）。
 */
export interface ImportNameMapFile {
  version: 1;
  providers: Record<
    string,
    Record<string, string | { filename: string; title?: string }>
  >;
}

export interface PageWriteResult {
  ref: string;
  locked_injected: boolean;
}

export interface PageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface PageWriteManyItem {
  ref: string;
  locked_injected: boolean;
}

export interface PageRmResult {
  deleted_pages: string[];
  rewritten_files: number;
}

/**
 * 写操作的返回封装：
 * - `null`：wiki 不存在或不属于 memory/team
 * - `"processing"`：wiki 当前处于 processing 状态，拒绝写
 * - `"invalid_path"`：路径穿越校验失败
 * - `"forbidden_path"`：写入了结构性文件等禁止路径
 * - `"too_large"`：超过容量限制
 * - 否则：实际结果对象
 */
export type WriteOutcome<T> =
  | T
  | null
  | "processing"
  | "invalid_path"
  | "forbidden_path"
  | "too_large";

const PAGE_WRITE_MAX_BYTES = 512 * 1024;
const RAW_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_RM_MAX = 20;
const RAW_RM_MAX = 50;
const RAW_READ_MAX = 50;
const RAW_WRITE_MAX = 50;
const PAGE_READ_MAX = 20;
const PAGE_WRITE_MAX = 20;

/** wiki/ 下不允许 page/write 与 page/rm 触碰的结构性文件（去掉 .md 也算）。 */
const PAGE_FORBIDDEN_REFS = new Set([
  "index",
  "schema",
  "purpose",
  "wiki/index",
  "wiki/schema",
  "wiki/purpose",
]);

export class WikiService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: WikiWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: WikiServiceLogger;
  private readonly callbackConfig?: {
    tmcCallbackUrl: string;
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
  /**
   * 中止标记（代际化，设计 2026-09-21 §3.3）。
   *
   * key = wiki_id，value = **被中止那一代** ingest 的 version。
   *
   * 为什么带代际：onBusy:'replace' 会在置标记后**立刻入队新任务**，而
   * SerialQueue 里新旧任务是同一个 wiki_id key。若只判 "是否有标记"，
   * 新任务 runBuild 入口检查点会把自己也当成"被中止"直接 abort，
   * 导致 wiki 卡在 draft、ingest 永不执行。带上 version 后：
   *   - 旧任务携带 version=N，标记里是 N → 命中，中止；
   *   - 新任务携带 version=N+1，标记里仍是 N → 不命中，正常执行。
   *
   * delete() 触发时用 -1 作哨兵值（匹配任意代际，因为行会被硬删，
   * 后续所有排队任务都该中止）。
   *
   * 仅内存态（同 id 由 SerialQueue 串行 + Node 单线程，读写无并发）。
   * 收尾后移除。
   */
  private readonly cancelled = new Map<string, number>();

  /** delete 的中止哨兵：匹配任意代际。 */
  private static readonly CANCEL_ALL_VERSIONS = -1;

  constructor(opts: WikiServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
  }

  dirFor(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dataRoot, serviceId, teamId, wikiId);
  }

  /**
   * 创建 wiki 元数据 + 目录壳。**不自动 ingest**。
   * 幂等：同 (service_id, team_id, name) 返回已有行。
   */
  create(params: CreateWikiParams): { row: WikiRow; existed: boolean } {
    const { row, existed } = this.store.createWiki(params);
    if (!existed) {
      const dir = this.dirFor(row.service_id, row.team_id, row.wiki_id);
      mkdirSync(join(dir, "raw", "sources"), { recursive: true });
      // 显式建 index.db（4 表，含 source）——此后 rawWrite/rawLs 直接读写 source 表（设计 006/003）。
      try {
        initIndexDb(dir);
      } catch (err) {
        this.logger?.warn?.(`[wiki] initIndexDb failed for ${row.wiki_id}: ${String(err)}`);
      }
      this.audit(row, "create", `create wiki ${row.name}`, params.user_id);
    }
    return { row, existed };
  }

  /** Persist service_url for a wiki. Returns updated row or null. */
  updateServiceUrl(serviceId: string, wikiId: string, serviceUrl: string): WikiRow | null {
    this.store.updateWikiStatus(serviceId, wikiId, { service_url: serviceUrl });
    return this.store.getWikiById(serviceId, wikiId);
  }

  /** Update wiki metadata (name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, wikiId: string, patch: { name?: string; summary?: string | null }): WikiRow | null {
    return this.store.updateWikiMeta(serviceId, wikiId, patch);
  }

  /**
   * 显式触发 ingest（LLM 加工 raw → page + 建索引）。
   * 立即返回，后台异步执行。memory/team 不匹配返回 not_found。
   *
   * 已有在途任务（pending/processing）时按 opts.onBusy 决定行为（设计 2026-09-21 §3.3）：
   *   - 'reject'（默认）：返回 busy（HTTP 409），不覆盖状态、不写 audit —— 原语义；
   *   - 'replace'：置 cancelled 标记 + internal_status='cancelling'，并把新任务排入
   *     SerialQueue（FIFO）。旧 worker 返回时由 runBuild 检查点做 preserveRaw 收尾
   *     （status 复位到 draft，保留 wiki 行与 raw），新任务出队后正常 scanning。
   *     这样"取消旧任务 + 排队新任务"在同一调用内原子完成，不存在中间脏态。
   */
  ingest(
    serviceId: string,
    teamId: string,
    wikiId: string,
    requesterUserId?: string,
    opts?: IngestOptions,
  ): IngestResult {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return { kind: "not_found" };

    const inFlightStatus = row.status === "pending" || row.status === "processing" ? row.status : null;
    if (inFlightStatus && opts?.onBusy !== "replace") {
      // 并发拒绝：正在排队/执行中直接拒绝，不覆盖状态、不重复入队、不写 audit。
      return { kind: "busy", status: inFlightStatus, step: row.internal_status };
    }
    const inFlight = inFlightStatus !== null;

    if (inFlight) {
      // replace 语义：只中止**当前这一代**（row.version），新任务 version+1 不受影响；
      // 同时置 cancelling 中间态供前端感知。
      this.cancelled.set(wikiId, row.version);
      this.store.updateWikiStatus(serviceId, wikiId, { internal_status: "cancelling" });
    }

    const nextVersion = row.version + 1;
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", inFlight ? "ingest (replace)" : "manual ingest", requesterUserId);
    const fresh = this.store.getWiki(serviceId, teamId, wikiId);
    if (fresh) this.enqueueBuild(fresh);
    if (!fresh) return { kind: "not_found" };
    return inFlight ? { kind: "queued", row: fresh } : { kind: "ok", row: fresh };
  }

  /** sync 语义 = 重跑 ingest（管控显式触发）。保持 reject 语义不变。 */
  sync(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): IngestResult {
    return this.ingest(serviceId, teamId, wikiId, requesterUserId);
  }

  get(serviceId: string, teamId: string, wikiId: string): WikiRow | null {
    return this.store.getWiki(serviceId, teamId, wikiId);
  }

  /** 按全局唯一 wiki_id 查询（仍按 service_id 收敛防跨租户）。spec id-only 端点专用。 */
  getById(serviceId: string, wikiId: string): WikiRow | null {
    return this.store.getWikiById(serviceId, wikiId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[] {
    return this.store.listWikis(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countWikis(serviceId, teamId, opts);
  }

  /**
   * 删除 wiki（008 / 007 §5.5）。任何状态均可删（含 pending/processing）。
   * memory/team 不匹配返回 false；否则硬删 + 四类资源清理，返回 true。
   *
   * 若资源正在排队/执行，先置 cancelled 标记通知 worker 在检查点中止，随后立即
   * 硬删 + 清理（不等 worker）。worker 结束前重查发现已删则跳过 ready/回调并再做
   * 一次幂等清理，无残留。
   */
  delete(serviceId: string, teamId: string, wikiId: string): boolean {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return false;

    if (row.status === "pending" || row.status === "processing") {
      // 哨兵 -1：delete 会硬删行，所有排队中的代际都该中止。
      this.cancelled.set(wikiId, WikiService.CANCEL_ALL_VERSIONS);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, wikiId);
    // 不在此删 cancelled 标记（覆盖 delete 先于 worker 检查点的窗口）；
    // worker 结束时由 finishCancelled 移除。cleanup 幂等，重复无害。
    return true;
  }

  /**
   * 四类资源幂等清理（顺序：先释放连接，再删盘）。每步独立 try/catch，异常安全。
   *   1. index.db 读连接池：evictWikiDb（幂等；worker 的 withWriteDb finally 本就 close 写连接）
   *   2. 元数据行：硬删（命中 0 行也安全，支持 worker + delete 双重清理）
   *   3. 磁盘目录（wiki/ raw/ index.db 及 -wal/-shm）：rmSync recursive+force（幂等）
   * BuildQueue 排队任务由 runBuild 入口检查 cancelled/行存在性跳过，无需在此处理。
   */
  private cleanupResources(serviceId: string, teamId: string, wikiId: string): void {
    try {
      evictWikiDb(wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] evict index.db failed ${wikiId}: ${String(err)}`);
    }
    try {
      this.store.deleteWiki(serviceId, teamId, wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] hard-delete row failed ${wikiId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, wikiId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[wiki] rm dir failed ${wikiId}: ${String(err)}`);
    }
  }

  /**
   * worker 检查点：本次 build 是否应中止。
   *
   * 双判据（覆盖 delete-during-run 与 delete-already-done 两种时序）：
   *   1. 代际化 cancelled 标记命中：标记代际为 -1（delete 哨兵，匹配任意代际），
   *      或等于本任务入队时的 version（replace 精确命中旧代际）；
   *   2. 行已不在库。
   *
   * 代际比对让 replace 入队的**新任务不会被自己触发的标记误伤**。
   */
  private isDeleted(serviceId: string, wikiId: string, version: number): boolean {
    const marked = this.cancelled.get(wikiId);
    const cancelledHit =
      marked !== undefined &&
      (marked === WikiService.CANCEL_ALL_VERSIONS || marked === version);
    return cancelledHit || this.store.getWikiById(serviceId, wikiId) === null;
  }

  /**
   * worker 检查点判定“需中止”后的收尾（幂等）。
   *
   * opts.preserveRaw=true（设计 2026-09-21 §3.3.2，由 ingest(onBusy:'replace') 触发）：
   *   仅把 status 复位到 draft —— 保留 wiki 元数据行、raw 与已 ready 的 pages，
   *   供后续新任务通过增量差分继续处理。不做任何删除动作。
   *
   * opts.preserveRaw=false 或省略（原 delete 触发）：
   *   evict 读连接池 + 硬删元数据行 + rmSync 磁盘目录（cleanupResources 三件套）。
   *
   * 两种分支都会移除 cancelled 标记。
   */
  private finishCancelled(
    serviceId: string,
    teamId: string,
    wikiId: string,
    opts?: { preserveRaw?: boolean },
  ): void {
    if (opts?.preserveRaw) {
      // 仅当"当前行仍是自己这一代（version <= 被取消代际）"才复位到 draft。
      //
      // 若新任务已经把 version 推高（replace 时 ingest() 会立刻 version+1 并置
      // pending），说明新任务已接管这一行 —— 此时**绝不能**复位，否则会把新
      // 任务的 pending 冲成 draft，前端就会看到"待加工/排队"的假窗口，实际是
      // 旧 worker 把新任务状态覆盖了。让位不动即可，新任务的状态由它自己驱动。
      const current = this.store.getWikiById(serviceId, wikiId);
      const cancelledVersion = this.cancelled.get(wikiId);
      const superseded =
        current !== null &&
        cancelledVersion !== undefined &&
        cancelledVersion !== WikiService.CANCEL_ALL_VERSIONS &&
        current.version > cancelledVersion;
      if (superseded) {
        this.logger?.info?.(
          `[wiki] ${wikiId} old build aborted; newer ingest (v${current?.version}) already owns status, leaving as-is`,
        );
      } else {
        this.store.updateWikiStatus(serviceId, wikiId, {
          status: "draft",
          internal_status: null,
          sync_error: "cancelled by user",
        });
        this.logger?.info?.(`[wiki] ${wikiId} build aborted (replaced by newer ingest; raw preserved)`);
      }
    } else {
      this.cleanupResources(serviceId, teamId, wikiId);
      this.logger?.info?.(`[wiki] ${wikiId} build aborted (deleted during processing)`);
    }
    this.cancelled.delete(wikiId);
  }

  /**
   * 判定本次中止的触发源：
   *   - wiki 行仍在 → ingest(onBusy:'replace') 触发 → preserveRaw（保留 raw）；
   *   - wiki 行已删 → delete() 触发 → 硬删。
   *
   * 注意：不能直接用 isDeleted() 区分（它是 cancelled 标记 OR 行不存在的双判据），
   * 必须单独查行是否存在。
   */
  private isCancelledByReplace(serviceId: string, wikiId: string): boolean {
    return this.store.getWikiById(serviceId, wikiId) !== null;
  }

  /** 写一条 wiki 审计记录。失败不阻断主流程。 */
  private audit(row: WikiRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendWikiAudit({
        service_id: row.service_id,
        asset_id: row.wiki_id,
        version: row.version,
        action,
        // 优先记录触发者（ingest/create 的发起人），回退到行上的创建者。
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] audit ${action} failed: ${String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 文件层 — raw/* （raw/sources/ 下的素材）
  // ═══════════════════════════════════════════════════════════════════

  /** 列出 raw/sources/ 下的素材文件（改查 source 表，设计 003 §3.5）。wiki 不存在返回 null。 */
  rawLs(serviceId: string, teamId: string, wikiId: string): RawFileEntry[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      const db = getReadDb(wikiId, dir);
      return listSources(db).map((s) => ({
        filename: s.filename,
        size: s.size,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_modified_by: s.last_modified_by,
        ingested_at: s.ingested_at,
        uploaded_at: s.created_at, // 兼容旧字段
      }));
    } catch {
      // index.db 尚未创建（老 wiki / 从未 rawWrite）→ 无 source 登记。
      return [];
    }
  }

  /** 读单个 raw 文件原文。文件不存在返回 null（含 wiki 不存在）。 */
  rawRead(serviceId: string, teamId: string, wikiId: string, filename: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 批量读 raw 文件。
   * - wiki 不存在 → null
   * - 任一 filename 路径穿越 → "invalid_path"
   * - 超 RAW_READ_MAX → 抛错（router 转 400）
   * 单个文件不存在不报错，对应 item 标 not_found:true（spec：整体仍 200）。
   */
  rawReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): WriteOutcome<RawReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (filenames.length > RAW_READ_MAX) {
      throw new Error(`filenames exceeds max ${RAW_READ_MAX}`);
    }
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    // 先全部校验路径合法性（任一不合法整批 400）
    const safePaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: RawReadItem[] = [];
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ filename, content });
      } catch {
        items.push({ filename, not_found: true });
      }
    }
    return items;
  }

  /**
   * 写入/覆盖单个 raw 文件（upsert）+ 登记 source 表（设计 003 §3.4）。
   * - wiki 不存在 → null
   * - processing 中 → "processing"
   * - 路径穿越 → "invalid_path"
   * - 超 5MB → "too_large"
   */
  rawWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filename: string,
    content: string,
    userId?: string,
  ): WriteOutcome<RawWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    // 注：此处**刻意不拦 processing**。设计 2026-09-21「导入并抽取」要求
    // "新导入覆盖旧导入"：抽取进行中再次导入时必须允许写入 raw，否则返回
    // 409 "wiki is processing; cannot write/delete" 阻断导入。
    // 安全性：跟随的 ingest(onBusy:'replace') 会取消旧任务，其产出的 page
    // 结果被 runBuild 检查点丢弃；新任务重新按 sha256 差分扫描全部 raw
    // （已 ingested 且 sha 未变者跳过），因此不存在脏数据落库。

    const size = Buffer.byteLength(content, "utf-8");
    if (size > RAW_WRITE_MAX_BYTES) return "too_large";

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return "invalid_path";

    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(safe, content, "utf-8");
    this.registerSources(serviceId, teamId, wikiId, [{ filename, content, size }], userId);
    return { filename, size };
  }

  /**
   * 批量写入 raw 文件（整批原子）。
   * - 先全部校验：路径穿越 → "invalid_path"；任一项超 5MB → "too_large"
   * - 全部通过后逐文件落盘；任一落盘失败回滚之前已写文件（删原有的不在请求里
   *   的文件），保证整批要么都成功要么都没生效。
   * 错误码同 rawWrite。
   */
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string }[],
    userId?: string,
  ): WriteOutcome<RawWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    // 同上（rawWrite）：刻意不拦 processing，以支持"抽取中再次导入"覆盖写入。
    if (files.length > RAW_WRITE_MAX) {
      throw new Error(`files exceeds max ${RAW_WRITE_MAX}`);
    }

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    type Plan = {
      filename: string;
      safePath: string;
      content: string;
      size: number;
      preExistingContent: string | null; // 落盘前已有则记下来，回滚要还原
    };
    const plans: Plan[] = [];
    for (const { filename, content } of files) {
      if (typeof content !== "string") return "invalid_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > RAW_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolveRawPath(sourcesDir, filename);
      if (!safe) return "invalid_path";
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ filename, safePath: safe, content, size, preExistingContent: pre });
    }

    mkdirSync(sourcesDir, { recursive: true });
    const written: Plan[] = [];
    try {
      for (const p of plans) {
        writeFileSync(p.safePath, p.content, "utf-8");
        written.push(p);
      }
    } catch (err) {
      // 回滚：恢复每个已写文件的旧内容（不存在则删）
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // 回滚也失败的话，只能记录由调用方重新跑 ingest 兜底
        }
      }
      throw err;
    }

    // 全部落盘成功后登记 source 表（先查再更新，sha 未变幂等）。
    this.registerSources(
      serviceId,
      teamId,
      wikiId,
      plans.map((p) => ({ filename: p.filename, content: p.content, size: p.size })),
      userId,
    );
    // 拉取入盘后 bump version + 更新 last_sync_at（设计 §3.1⑥）。
    // - version 用于下游变更检测（ingest 时对比源文件版本 vs 已抽取版本）
    // - last_sync_at 用于外部同步观测点（"上次拉取时间"）
    // 幂等：即使 files 内容全部相同，写盘 + 登记也走一遍，版本仍会前进，
    //   这是 SoT（wiki 表状态）的期望行为：raw 一旦被写过就算作新版本，
    //   由下游 ingest 决定是否真的重新抽取（sha 相同则跳过）。
    if (plans.length > 0) {
      this.store.updateWikiStatus(serviceId, wikiId, {
        version: row.version + 1,
        last_sync_at: new Date().toISOString(),
      });
    }
    return plans.map(({ filename, size }) => ({ filename, size }));
  }

  // ─────────────────────────────────────────────────────────────
  // 导入文件名映射（externalId → filename）
  //
  // 背景：wiki 导入（wiki-source）落盘文件名取自文档**标题**（可读性好），
  // 但标题会变，而"标题"不是稳定身份。定时同步每轮全量重拉、且去重组只在单轮内有效，
  // 于是远端改名后会出现：新标题 → 新建文件；另一篇仍用旧标题 → 复用旧文件名并覆盖，
  // 造成内容串档 + 残留垃圾文件，且无任何告警。
  //
  // 解决：把 provider+externalId → filename 持久化到 wiki 目录下的 import-map.json。
  // 已导入过的文档复用旧文件名，标题仅作展示。存储放在这里（而非 import-runner）是因为
  // 只有本类持有 dataRoot / dirFor()，调用方无需再透传路径。
  // ─────────────────────────────────────────────────────────────

  /** 映射文件路径：`<wikiDir>/import-map.json`。 */
  private importMapPath(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dirFor(serviceId, teamId, wikiId), "import-map.json");
  }

  /**
   * 读取某 provider 的文件名映射。
   * 文件缺失/损坏 → 返回空对象（降级为"按标题生成"的旧行为，不阻断导入）。
   */
  readImportNameMap(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
  ): Record<string, string> {
    try {
      const p = this.importMapPath(serviceId, teamId, wikiId);
      if (!existsSync(p)) return {};
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ImportNameMapFile | null;
      const providers = parsed?.providers;
      if (!providers || typeof providers !== "object") return {};
      const m = providers[providerId];
      // 兼容旧结构：值可能是 { filename } 对象
      if (!m || typeof m !== "object") return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        const fn = typeof v === "string" ? v : v?.filename;
        if (typeof fn === "string" && fn) out[k] = fn;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * 写回某 provider 的文件名映射（整份覆盖）。
   * 写失败只记日志——文件本身已落盘，映射丢失仅影响下一轮的名字复用，不阻断当前导入。
   */
  writeImportNameMap(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
    map: Record<string, string>,
  ): void {
    try {
      const p = this.importMapPath(serviceId, teamId, wikiId);
      let file: ImportNameMapFile = { version: 1, providers: {} };
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(readFileSync(p, "utf-8")) as ImportNameMapFile | null;
          if (parsed && typeof parsed === "object" && parsed.providers) file = parsed;
        } catch {
          // 损坏则整体重建
        }
      }
      file.providers[providerId] = map;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(file, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`import-map write failed: ${msg}`);
    }
  }

  /**
   * 批量删除 raw 文件 + 级联清理下游 page。
   * 调用 lib 层 deleteSourceFiles，由其内部决定 page 命运。
   * - wiki 不存在 → null
   * - processing → "processing"
   * - filenames 含路径穿越 → "invalid_path"
   * - 超 50 → 抛错（由 router 转 400）
   */
  async rawRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): Promise<WriteOutcome<RawRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (filenames.length > RAW_RM_MAX) {
      throw new Error(`filenames exceeds max ${RAW_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const sourcesDir = join(projectPath, "raw", "sources");
    const fullPaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    // 自研级联删除：删 raw 源并清理引用它的 page（frontmatter sources 驱动）。
    const { deleteSourceFiles } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await deleteSourceFiles(projectPath, fullPaths, {
      logReason: "wiki/raw/rm",
    });

    // 删除对应 source 行（与文件级联删除对应，设计 003 §5）。
    try {
      initIndexDb(projectPath);
      withWriteDb(projectPath, (db) => deleteSources(db, filenames));
    } catch (err) {
      this.logger?.warn?.(`[wiki] source rows delete failed: ${String(err)}`);
    }

    return {
      deleted_files: filenames,
      deleted_pages: result.deletedWikiPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_pages: result.rewrittenSourcePages,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 文件层 — page/* （wiki/ 下的 processed page）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 列出 wiki/ 下的 page 文件（recursive 扫描 .md 取 frontmatter）。
   * status≠ready 时返回空数组。
   */
  pageLs(serviceId: string, teamId: string, wikiId: string): { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status !== "ready") return [];

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) return [];

    const items: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] = [];
    this.scanPagesRecursive(wikiDir, wikiDir, items);
    return items;
  }

  /** 读单个 page 原文。ref 可以是 page id 或 relPath。 */
  pageRead(serviceId: string, teamId: string, wikiId: string, ref: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 批量读 page 原文。
   * - wiki 不存在 → null
   * - 任一 ref 路径穿越 → "invalid_path"
   * - 超 PAGE_READ_MAX → 抛错
   * 单个 ref 不存在不报错，对应 item 标 not_found:true（spec：整体仍 200）。
   */
  pageReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): WriteOutcome<PageReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (refs.length > PAGE_READ_MAX) {
      throw new Error(`refs exceeds max ${PAGE_READ_MAX}`);
    }
    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safePaths: string[] = [];
    for (const r of refs) {
      // 读用 allowMissing 不行——not_found 也得是合法路径，所以这里
      // 区分"路径合法但文件不存在（not_found）"与"路径非法（invalid_path）"
      const safe = this.resolvePageRef(projectPath, r, { allowMissing: true });
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: PageReadItem[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ ref, content });
      } catch {
        items.push({ ref, not_found: true });
      }
    }
    return items;
  }

  /**
   * 写入/覆盖单个 page（upsert）。自动在 frontmatter 注入 `locked: true`。
   * - wiki 不存在 → null
   * - processing → "processing"
   * - 路径穿越 → "invalid_path"
   * - 结构性文件 → "forbidden_path"
   * - 超 512KB → "too_large"
   */
  pageWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    ref: string,
    content: string,
  ): WriteOutcome<PageWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";

    const size = Buffer.byteLength(content, "utf-8");
    if (size > PAGE_WRITE_MAX_BYTES) return "too_large";

    if (this.isForbiddenPageRef(ref)) return "forbidden_path";

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
    if (!safe) return "invalid_path";

    const { content: finalContent, lockedInjected } = injectLockedTrue(content);

    mkdirSync(join(safe, ".."), { recursive: true });
    writeFileSync(safe, finalContent, "utf-8");
    return { ref, locked_injected: lockedInjected };
  }

  /**
   * 批量写 page（整批原子）。每项自动注入 frontmatter `locked: true`。
   * - 先全部校验：处理中 → "processing"；路径穿越 → "invalid_path"；
   *   结构性文件 → "forbidden_path"；超 512KB → "too_large"
   * - 全部通过后逐文件落盘；任一失败回滚已写文件。
   */
  pageWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    pages: { ref: string; content: string }[],
  ): WriteOutcome<PageWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (pages.length > PAGE_WRITE_MAX) {
      throw new Error(`pages exceeds max ${PAGE_WRITE_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    type Plan = {
      ref: string;
      safePath: string;
      finalContent: string;
      lockedInjected: boolean;
      preExistingContent: string | null;
    };
    const plans: Plan[] = [];
    for (const { ref, content } of pages) {
      if (typeof content !== "string") return "invalid_path";
      if (this.isForbiddenPageRef(ref)) return "forbidden_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > PAGE_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
      if (!safe) return "invalid_path";
      const { content: finalContent, lockedInjected } = injectLockedTrue(content);
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ ref, safePath: safe, finalContent, lockedInjected, preExistingContent: pre });
    }

    const written: Plan[] = [];
    try {
      for (const p of plans) {
        mkdirSync(join(p.safePath, ".."), { recursive: true });
        writeFileSync(p.safePath, p.finalContent, "utf-8");
        written.push(p);
      }
    } catch (err) {
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // best-effort 回滚
        }
      }
      throw err;
    }

    return plans.map(({ ref, lockedInjected }) => ({ ref, locked_injected: lockedInjected }));
  }

  /**
   * 批量删除 page + 级联清理引用。调用 lib 层 cascadeDeleteWikiPagesWithRefs。
   * - wiki 不存在 → null
   * - processing → "processing"
   * - 含路径穿越 → "invalid_path"
   * - 含结构性文件 → "forbidden_path"
   * - 超 20 → 抛错
   */
  async pageRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): Promise<WriteOutcome<PageRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (refs.length > PAGE_RM_MAX) {
      throw new Error(`refs exceeds max ${PAGE_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const fullPaths: string[] = [];
    for (const r of refs) {
      if (this.isForbiddenPageRef(r)) return "forbidden_path";
      const safe = this.resolvePageRef(projectPath, r);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    const { cascadeDeleteWikiPagesWithRefs } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await cascadeDeleteWikiPagesWithRefs(projectPath, fullPaths);

    return {
      deleted_pages: result.deletedPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_files: result.rewrittenFiles,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部 helper
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 登记一批源文件到 source 表（rawWrite/rawWriteMany 用）。
   * 保证 index.db 存在（幂等 initIndexDb），在一个写事务里对每个文件 upsertSource
   * （先查再更新：新建 uploaded / sha 变则重置 uploaded / sha 未变幂等）。
   * 登记失败不阻断写盘主流程（文件已落盘）——记 warn，交由后续 ingest/rawLs 兜底。
   */
  private registerSources(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string; size: number }[],
    userId?: string,
  ): void {
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      initIndexDb(dir);
      withWriteDb(dir, (db) => {
        for (const f of files) {
          upsertSource(db, {
            filename: f.filename,
            sha256: sha256(f.content),
            size: f.size,
            userId: userId ?? null,
          });
        }
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] source register failed for ${wikiId}: ${String(err)}`);
    }
  }

  private resolveRawPath(sourcesDir: string, filename: string): string | null {
    if (!filename || filename.includes("..") || filename.startsWith("/")) return null;
    const normalized = normalize(filename);
    if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
    // resolve(sourcesDir) 转成绝对路径，避免 sourcesDir 是相对路径时
    // （如 KNOWLEDGE_DATA_DIR=./data）与 resolve 出来的绝对路径比较失败。
    const base = resolve(sourcesDir);
    const safe = resolve(base, normalized);
    const dirWithSep = base.endsWith("/") ? base : base + "/";
    if (safe !== base && !safe.startsWith(dirWithSep)) return null;
    return safe;
  }

  /**
   * 解析 page ref（id 或 relPath）→ 绝对路径。要求落在 wiki/ 子树下。
   * - allowMissing=true 用于 write，路径不存在仍允许
   * - allowMissing=false 用于 read/rm，要求文件已存在
   */
  private resolvePageRef(
    projectPath: string,
    ref: string,
    opts: { allowMissing?: boolean } = {},
  ): string | null {
    if (!ref || ref.includes("..") || ref.startsWith("/")) return null;
    const cleanRef = ref.replace(/^wiki\//, "");
    if (cleanRef.includes("..")) return null;

    // resolve 成绝对路径，避免 projectPath 是相对路径时比较失败。
    const wikiDir = resolve(projectPath, "wiki");
    const wikiDirSep = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";

    // 先按原样尝试，再尝试补 .md 扩展。
    const candidates = cleanRef.endsWith(".md") ? [cleanRef] : [cleanRef + ".md", cleanRef];
    for (const c of candidates) {
      const safe = resolve(wikiDir, c);
      if (safe !== wikiDir && !safe.startsWith(wikiDirSep)) continue;
      if (opts.allowMissing) {
        // write 路径补 .md：允许任何其中一个
        return c.endsWith(".md") ? safe : null;
      }
      if (existsSync(safe)) return safe;
    }
    if (opts.allowMissing) {
      // 没匹配 .md 候选时，强制补 .md
      const safe = resolve(wikiDir, cleanRef.endsWith(".md") ? cleanRef : cleanRef + ".md");
      if (safe === wikiDir || !safe.startsWith(wikiDirSep)) return null;
      return safe;
    }
    return null;
  }

  /** 把 wiki/.../page.md 绝对路径转换回 ref（如 "concepts/redis"）。 */
  private absToPageRef(projectPath: string, abs: string): string {
    const wikiDir = resolve(projectPath, "wiki");
    const prefix = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";
    if (!abs.startsWith(prefix)) return abs;
    return abs.slice(prefix.length).replace(/\.md$/, "");
  }

  private isForbiddenPageRef(ref: string): boolean {
    const cleanRef = ref.replace(/^wiki\//, "").replace(/\.md$/, "");
    return PAGE_FORBIDDEN_REFS.has(cleanRef) || PAGE_FORBIDDEN_REFS.has(`wiki/${cleanRef}`);
  }

  private scanPagesRecursive(
    baseDir: string,
    dir: string,
    out: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[],
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "media") continue;
        this.scanPagesRecursive(baseDir, full, out);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      let content = "";
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const rel = full.slice(baseDir.length + 1).replace(/\\/g, "/");
      const id = rel.replace(/\.md$/, "");
      const fm = parseFrontmatterMin(content);
      out.push({
        id,
        title: fm.title || entry.replace(/\.md$/, "").replace(/-/g, " "),
        type: fm.type || "other",
        path: `wiki/${rel}`,
        ...(fm.description ? { description: fm.description } : {}),
        locked: fm.locked,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  private enqueueBuild(row: WikiRow): void {
    // 代际 version 随任务一起入队：runBuild 用它与 cancelled 标记比对，
    // 使 replace 新入队的任务（version 更大）不会被旧代际的标记误伤。
    const version = row.version;
    this.queue.enqueue(row.wiki_id, () =>
      this.runBuild(row.service_id, row.wiki_id, row.team_id, row.name, version),
    );
  }

  private async runBuild(
    serviceId: string,
    wikiId: string,
    teamId: string,
    name: string,
    version: number,
  ): Promise<void> {
    // 入口检查点：pending 期间被中止 → 跳过，不置 processing、不 ingest。
    // preserveRaw 由触发源决定：replace（行仍在）保留 raw，delete（行已删）硬删。
    if (this.isDeleted(serviceId, wikiId, version)) {
      this.finishCancelled(serviceId, teamId, wikiId, {
        preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
      });
      return;
    }
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "processing",
      internal_status: "scanning",
      sync_error: null,
    });
    // 进度/终态 callback 共用同一代际，Panel 可拒绝 clear 后的迟到 progress
    const ingestRunId = randomUUID();
    try {
      const result = await this.worker({
        wikiId,
        serviceId,
        teamId,
        name,
        dir: this.dirFor(serviceId, teamId, wikiId),
        setInternalStatus: (s) =>
          this.store.updateWikiStatus(serviceId, wikiId, { status: "processing", internal_status: s }),
        ingestRunId,
      });
      // 结束前检查点：processing 期间被中止 → 跳过 ready/audit/回调，幂等收尾。
      if (this.isDeleted(serviceId, wikiId, version)) {
        this.finishCancelled(serviceId, teamId, wikiId, {
          preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
        });
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        page_count: result?.pageCount ?? null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getWikiById(serviceId, wikiId);
      if (synced) {
        this.audit(synced, "ready", result?.pageCount != null ? `pages: ${result.pageCount}` : null);
      }
      this.logger?.info?.(`[wiki] ${wikiId} ready (pages: ${result?.pageCount ?? '?'})`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, ingestRunId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // worker 抛错，但若期间已被中止，视为取消而非失败：跳过 failed 状态/回调，做收尾。
      if (this.isDeleted(serviceId, wikiId, version)) {
        this.finishCancelled(serviceId, teamId, wikiId, {
          preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
        });
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getWikiById(serviceId, wikiId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[wiki] ${wikiId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, ingestRunId);
    }
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: WikiRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    ingestRunId?: string,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via LLM (即使部分源失败也尝试生成——只要有页面就生成)
      try {
        const pages = this.pageLs(row.service_id, row.team_id, row.wiki_id) ?? [];
        this.logger?.info?.(`[wiki] summary generation start (wikiId=${row.wiki_id}, pages=${pages.length}, status=${status})`);
        const { generateWikiSummary } = await import("../callback.js");
        summary = await generateWikiSummary(
          row.wiki_id,
          row.name,
          pages.map((p) => ({ title: p.title, description: p.description })),
          this.callbackConfig.resolveLlm(row.service_id),
        );
        this.logger?.info?.(`[wiki] summary generation done (wikiId=${row.wiki_id}, len=${summary?.length ?? 0}, empty=${!summary})`);
        if (summary) {
          this.store.updateWikiStatus(row.service_id, row.wiki_id, { summary });
        }
      } catch (err) {
        this.logger?.warn?.(`[wiki] summary generation failed: ${String(err)}`);
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.wiki_id,
        service_id: row.service_id,
        type: "wiki",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
        ...(ingestRunId ? { run_id: ingestRunId } : {}),
      },
      this.callbackConfig,
    );
  }

  async onIdle(wikiId?: string): Promise<void> {
    await this.queue.onIdle(wikiId);
  }
}

// ─── 模块级 helper（不依赖 class state，便于单测） ───

/** 极简 frontmatter 解析（取 title/type/description/locked），与 manager 一致风格。 */
function parseFrontmatterMin(content: string): { title: string; type: string; description: string; locked: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  // description 由 ingest-v2 写入（见 engines/wiki/ingest-v2/frontmatter.ts），
  // 是页面的一句话概述——比标题更能说明内容，用于生成 wiki summary。
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const lockedMatch = fm.match(/^locked:\s*(true|false)\s*$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : "",
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "",
    description: descMatch ? descMatch[1].trim() : "",
    locked: lockedMatch ? lockedMatch[1] === "true" : false,
  };
}

/**
 * 在 frontmatter 中注入 `locked: true`：
 * - 有 frontmatter：若已有 locked: 字段，强制改 true；否则在 frontmatter 末尾追加一行
 * - 无 frontmatter：在文件最前面包一段 frontmatter（仅含 locked: true）
 *
 * 返回 { content, lockedInjected }；lockedInjected 表示**本次**是否真正补/改了 locked
 * 字段（已是 true 也算 lockedInjected=false，因为没有改动）。
 */
function injectLockedTrue(content: string): { content: string; lockedInjected: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const wrapped = `---\nlocked: true\n---\n${content.startsWith("\n") ? content.slice(1) : content}`;
    return { content: wrapped, lockedInjected: true };
  }
  const fmBody = fmMatch[1];
  const lockedMatch = fmBody.match(/^locked:\s*(true|false)\s*$/m);
  if (lockedMatch) {
    if (lockedMatch[1] === "true") return { content, lockedInjected: false };
    const newFmBody = fmBody.replace(/^locked:\s*(true|false)\s*$/m, "locked: true");
    return {
      content: content.replace(fmBody, newFmBody),
      lockedInjected: true,
    };
  }
  const newFmBody = fmBody.endsWith("\n") ? `${fmBody}locked: true` : `${fmBody}\nlocked: true`;
  return {
    content: content.replace(fmBody, newFmBody),
    lockedInjected: true,
  };
}

export const __testing = { parseFrontmatterMin, injectLockedTrue };
