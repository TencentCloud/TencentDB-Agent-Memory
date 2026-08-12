/**
 * CodeGraphService — code-graph 资产的异步编排。
 *
 * 把 IKnowledgeStore（元数据/状态）+ BuildQueue（后台串行）+ 可注入的
 * worker（实际 git clone + codegraph 建图）粘合，实现：
 *   - create/sync 立即返回（fire-and-forget），管控轮询 status；
 *   - 状态机 pending → processing(cloning/indexing) → ready / failed(+sync_error)；
 *   - memory + team 隔离、幂等（同 memory+team+repo+branch 返回已存在）、硬删 + 四类资源清理。
 *
 * delete 语义（008 / 007 §5.5）：任何状态（含 pending/processing）均可删。
 * 用内存 cancelled 标记通知 in-flight worker 中止（不落库、不软删）；worker 在
 * 结束前的检查点发现被删则跳过 ready/回调并做幂等清理。清理覆盖四类资源：
 * instance pool（内存）→ 元数据行（硬删）→ 磁盘目录（rmSync），分步 try/catch
 * 保证任一步失败不影响其余（异常安全 + 幂等）。远端元数据上报本阶段不做。
 *
 * worker 注入便于单测（无需真实 git/codegraph）；生产实现见 router 装配处。
 * 物理目录：{dataRoot}/{service_id}/{team_id}/{code_graph_id}/（001 多租户）。
 */

import { join } from "node:path";
import { rmSync } from "node:fs";

import type {
  AuditAction,
  CodeGraphRow,
  IKnowledgeStore,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import type { SecretStore } from "../secrets/secret-store.js";

/** 私有仓库认证配置（worker 执行期使用；明文只存在于 worker 调用栈，绝不落库/队列/日志）。 */
export interface CodeGraphAuth {
  /** 与 source-fetcher FetchOptions.authMethod 同名字段，透传给 fetcher 时零映射。 */
  authMethod: "none" | "token" | "ssh";
  accessToken?: string;
  tokenUsername?: string;
  sshPrivateKey?: string;
  /** 凭据引用（审计/观测用；无明文）。 */
  credentialRef?: string;
  /** 托管提供商（known_hosts 选择/观测）。 */
  provider?: "github" | "gitlab" | "gitea" | "generic";
}

/**
 * 脱敏 URL 中的凭据（https://user:token@ → https://***@）。
 * git 自带密码 redact 不覆盖 curl 层错误，sync_error 落库/回调前必须过此函数。
 */
export function redactCredentials(s: string): string {
  return s.replace(/https?:\/\/[^@\s/]+@/gi, "https://***@");
}

export interface CodeGraphBuildContext {
  codeGraphId: string;
  serviceId: string;
  teamId: string;
  repoUrl: string;
  branch: string;
  /** 私有仓库认证配置（公开仓库为 undefined）。 */
  auth?: CodeGraphAuth;
  /** 该资产的本地工作目录（checkout + 索引落此）。 */
  dir: string;
  /** worker 可调用以更新细粒度内部状态（cloning → indexing）。 */
  setInternalStatus: (s: string) => void;
}

export interface CodeGraphBuildResult {
  commitHash?: string;
  stats?: { files: number; nodes: number; edges: number };
}

export type CodeGraphWorker = (ctx: CodeGraphBuildContext) => Promise<CodeGraphBuildResult>;

/**
 * sync 结果（判别联合）：
 *   - ok       已入队重建；
 *   - not_found memory/team/id 不匹配；
 *   - busy     正在 pending/processing（并发拒绝，对应 HTTP 409），step 为内部阶段（可 null）。
 */
export type SyncResult =
  | { kind: "ok"; row: CodeGraphRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

export interface CodeGraphServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CodeGraphServiceOptions {
  store: IKnowledgeStore;
  /** knowledge 数据根目录；资产目录 = {dataRoot}/{service_id}/{team_id}/{code_graph_id}/。 */
  dataRoot: string;
  worker: CodeGraphWorker;
  queue?: BuildQueue;
  logger?: CodeGraphServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: { tmcCallbackUrl: string };
  /**
   * 释放该 code-graph 占用的内存资源（instance pool + 关闭索引句柄）。
   * 注入而非直依赖 module，保持 store 层不反向依赖装配层。幂等：重复调用安全。
   * 由 module.ts 装配时提供（封装 instancePool.delete + closeIndex）。
   */
  releaseInstance?: (codeGraphId: string) => void;
  /**
   * 凭据存储（949spec §5.3）。配置后 create 的凭据以引用方式落库，
   * 执行期由 worker 解析明文（仅内存）；未配置时回退 legacy 明文列（迁移期）。
   */
  secretStore?: SecretStore;
}

export interface CreateCodeGraphParams {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  auth_method?: string;
  access_token?: string | null;
  token_username?: string | null;
  ssh_private_key?: string | null;
  // 凭据引用（949spec §5.2）：优先使用；access_token/ssh_private_key 为迁移期兼容。
  credential_ref?: string | null;
  credential_version?: number | null;
  credential_fingerprint?: string | null;
  credential_provider?: string | null;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
}

export class CodeGraphService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: CodeGraphWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: CodeGraphServiceLogger;
  private readonly callbackConfig?: { tmcCallbackUrl: string };
  private readonly releaseInstance?: (codeGraphId: string) => void;
  private readonly secretStore?: SecretStore;
  /**
   * In-flight delete 标记：delete 命中一个正在排队/执行的资源时置位，
   * worker 在检查点读取以决定中止。仅内存态（同 id 由 SerialQueue 串行 +
   * Node 单线程，读写无并发）。清理收尾后移除。
   */
  private readonly cancelled = new Set<string>();

  constructor(opts: CodeGraphServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
    this.releaseInstance = opts.releaseInstance;
    this.secretStore = opts.secretStore;
  }

  dirFor(serviceId: string, teamId: string, codeGraphId: string): string {
    return join(this.dataRoot, serviceId, teamId, codeGraphId);
  }

  /**
   * 幂等创建并异步建图。
   * - 已存在（同 memory+team+repo+branch）→ 直接返回已有行，不重复建图。
   * - 新建 → 入库 pending + 后台建图。
   *
   * 凭据绑定（949spec §5.1/§5.2/§29 Phase 3 new-write-only）：
   *   新写入优先 SecretStore —— 明文仅在首次创建时短暂存在于调用栈，立即加密转入
   *   SecretStore，行上只落 credential_ref；随后清空 legacy 明文列。
   *   未配置 SecretStore 时回退明文列（迁移期兼容）。
   */
  async create(params: CreateCodeGraphParams): Promise<{ row: CodeGraphRow; existed: boolean }> {
    const { row, existed } = this.store.createCodeGraph(params);
    if (!existed) {
      // 凭据绑定：拿到真实 code_graph_id 后创建 Secret（AAD 绑定资源上下文）。
      await this.bindCredentials(row, params);
      const bound = this.store.getCodeGraphById(row.service_id, row.code_graph_id) ?? row;
      this.audit(bound, "create", `clone ${bound.repo_url}@${bound.branch}`, params.user_id);
      this.enqueueBuild(bound);
      return { row: bound, existed };
    }
    return { row, existed };
  }

  /**
   * 凭据绑定（§5.2）：credential_ref 已给 → 直接绑定元数据；
   * 明文已给且配置 SecretStore → createSecret 转引用 + 清明文列。
   */
  private async bindCredentials(row: CodeGraphRow, params: CreateCodeGraphParams): Promise<void> {
    const needsAuth = params.auth_method === "token" || params.auth_method === "ssh";
    if (!needsAuth) return;

    if (params.credential_ref) {
      this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
        credential_ref: params.credential_ref,
        credential_version: params.credential_version ?? null,
        credential_status: "active",
        credential_fingerprint: params.credential_fingerprint ?? null,
        credential_provider: params.credential_provider ?? null,
        // 有引用即不再保留明文（§5.1）
        access_token: null,
        token_username: null,
        ssh_private_key: null,
      });
      return;
    }

    if (!this.secretStore) return; // 迁移期：明文列路径

    const authMethod = params.auth_method as "token" | "ssh";
    const secret = authMethod === "ssh" ? params.ssh_private_key : params.access_token;
    if (!secret) return;

    const ref = await this.secretStore.createSecret({
      serviceId: row.service_id,
      teamId: row.team_id,
      codeGraphId: row.code_graph_id,
      authMethod,
      secret,
      username: params.token_username ?? undefined,
      provider: (params.credential_provider ?? undefined) as never,
    });
    this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
      credential_ref: ref.credentialRef,
      credential_version: ref.credentialVersion,
      credential_status: "active",
      credential_fingerprint: ref.fingerprint ?? null,
      credential_provider: params.credential_provider ?? null,
      // 明文已转入 SecretStore → 清空 legacy 列（§5.1：CodeGraph 表不含明文）
      access_token: null,
      token_username: null,
      ssh_private_key: null,
    });
  }

  /** Persist service_url for a code-graph. Returns updated row or null. */
  updateServiceUrl(serviceId: string, codeGraphId: string, serviceUrl: string): CodeGraphRow | null {
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, { service_url: serviceUrl });
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  /**
   * 更新凭据绑定元数据（§20 rotation/§22 revocation 后的引用状态透出）。
   * 只写引用元数据，绝不接受明文。
   */
  updateCredentialBinding(
    serviceId: string,
    codeGraphId: string,
    patch: {
      credential_version?: number | null;
      credential_status?: string | null;
      credential_fingerprint?: string | null;
      credential_last_validated_at?: string | null;
      credential_last_auth_failure_at?: string | null;
    },
  ): void {
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, patch);
  }

  /** Update code-graph metadata (repo_name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): CodeGraphRow | null {
    return this.store.updateCodeGraphMeta(serviceId, codeGraphId, patch);
  }

  /** 重新拉取 + 重建（管控显式触发）。memory/team 不匹配返回 not_found；pending/processing 返回 busy。 */
  sync(serviceId: string, teamId: string, codeGraphId: string, requesterUserId?: string): SyncResult {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return { kind: "not_found" };
    // 并发拒绝：正在排队/执行中直接拒绝，不覆盖状态、不重复入队、不写 audit。
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const nextVersion = row.version + 1;
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", "manual sync", requesterUserId);
    const fresh = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (fresh) this.enqueueBuild(fresh);
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  get(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraph(serviceId, teamId, codeGraphId);
  }

  /** 按全局唯一 code_graph_id 查询（仍按 service_id 收敛防跨租户）。spec id-only 端点专用。 */
  getById(serviceId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[] {
    return this.store.listCodeGraphs(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countCodeGraphs(serviceId, teamId, opts);
  }

  /**
   * 删除 code-graph（008 / 007 §5.5）。任何状态均可删（含 pending/processing）。
   * memory/team 不匹配返回 false；否则硬删 + 四类资源清理，返回 true。
   *
   * 若资源正在排队/执行（pending/processing），先置 cancelled 标记通知 worker
   * 在检查点中止；随后立即硬删 + 清理（不等 worker）。worker 结束前重查发现
   * 已删则跳过 ready/回调并再做一次幂等清理，无残留。
   */
  delete(serviceId: string, teamId: string, codeGraphId: string): boolean {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return false;

    // 通知 in-flight worker 中止（pending 排队 or processing 执行中）。
    if (row.status === "pending" || row.status === "processing") {
      this.cancelled.add(codeGraphId);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, codeGraphId);

    // worker 若仍在跑，会在检查点看到行已被硬删（getById → null）而中止；
    // cancelled 标记留到 worker 结束由其自行清理（见 runBuild），此处不删标记，
    // 以覆盖“delete 先于 worker 检查点完成”的窗口。cleanup 幂等，重复无害。
    return true;
  }

  /**
   * 四类资源幂等清理（顺序：先释放内存/连接，再删盘）。
   * 每步独立 try/catch —— 任一步失败不影响其余，保证异常安全。
   *   1. instance pool（内存）：releaseInstance（pool.delete + closeIndex）
   *   2. 元数据行：硬删（命中 0 行也安全，支持 worker + delete 双重清理）
   *   3. 磁盘目录：rmSync recursive+force（幂等）
   * BuildQueue 排队任务由 runBuild 入口检查 cancelled/行存在性跳过，无需在此处理。
   */
  private cleanupResources(serviceId: string, teamId: string, codeGraphId: string): void {
    try {
      this.releaseInstance?.(codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] release instance failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      this.store.deleteCodeGraph(serviceId, teamId, codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] hard-delete row failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, codeGraphId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] rm dir failed ${codeGraphId}: ${String(err)}`);
    }
  }

  /**
   * worker 检查点：资源是否已被删除（cancelled 标记命中，或行已不在库）。
   * 双判据覆盖：①delete 发生在 worker 运行中（cancelled）；②delete 已完成
   * 且行被硬删（getById → null）。任一即视为已删。
   */
  private isDeleted(serviceId: string, codeGraphId: string): boolean {
    return this.cancelled.has(codeGraphId) || this.store.getCodeGraphById(serviceId, codeGraphId) === null;
  }

  /** 写一条 code-graph 审计记录。失败不阻断主流程。 */
  private audit(row: CodeGraphRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendCodeGraphAudit({
        service_id: row.service_id,
        asset_id: row.code_graph_id,
        version: row.version,
        action,
        // 优先记录触发者（sync/create 的发起人），回退到行上的创建者。
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] audit ${action} failed: ${String(err)}`);
    }
  }

  private enqueueBuild(row: CodeGraphRow): void {
    this.queue.enqueue(row.code_graph_id, () =>
      this.runBuild(
        row.service_id,
        row.code_graph_id,
        row.team_id,
        row.repo_url,
        row.branch,
      ),
    );
  }

  /**
   * 执行期解析认证配置（949spec §7：明文只允许在执行时、worker 内、最短寿命存在）。
   *   1. credential_ref 存在 → 从 SecretStore 解析（优先路径）；
   *   2. 否则 legacy 明文列（迁移期兼容，Phase 2/3 过渡）；
   *   3. auth_method=none → undefined（公开仓库）。
   * 解析失败（凭据被吊销/删除/存储不可用）→ 抛错 → worker 置 failed（§22 fail closed）。
   */
  private async resolveAuth(row: CodeGraphRow): Promise<CodeGraphAuth | undefined> {
    if (!row.auth_method || row.auth_method === "none") return undefined;

    if (row.credential_ref) {
      if (!this.secretStore) {
        throw new Error(`credential_ref ${row.credential_ref} present but SecretStore is not configured`);
      }
      const resolved = await this.secretStore.getSecret(row.credential_ref);
      if (!resolved) {
        throw new Error(`credential ${row.credential_ref} not found or revoked`);
      }
      const provider = (row.credential_provider ?? undefined) as
        | "github" | "gitlab" | "gitea" | "generic" | undefined;
      if (resolved.authMethod === "ssh") {
        return {
          authMethod: "ssh",
          sshPrivateKey: resolved.secret,
          credentialRef: resolved.credentialRef,
          provider,
        };
      }
      return {
        authMethod: "token",
        accessToken: resolved.secret,
        tokenUsername: resolved.username,
        credentialRef: resolved.credentialRef,
        provider,
      };
    }

    // 迁移期兼容路径（legacy 明文列）。
    return {
      authMethod: row.auth_method as CodeGraphAuth["authMethod"],
      accessToken: row.access_token ?? undefined,
      tokenUsername: row.token_username ?? undefined,
      sshPrivateKey: row.ssh_private_key ?? undefined,
      provider: (row.credential_provider ?? undefined) as
        | "github" | "gitlab" | "gitea" | "generic" | undefined,
    };
  }

  private async runBuild(
    serviceId: string,
    codeGraphId: string,
    teamId: string,
    repoUrl: string,
    branch: string,
  ): Promise<void> {
    // 入口检查点：pending 期间被删 → 直接跳过，不置 processing、不建图。
    if (this.isDeleted(serviceId, codeGraphId)) {
      this.finishCancelled(serviceId, teamId, codeGraphId);
      return;
    }
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "processing",
      internal_status: "cloning",
      sync_error: null,
    });
    try {
      const row = this.store.getCodeGraphById(serviceId, codeGraphId);
      // 执行期解析凭据（明文只存在于本 worker 调用栈；失败 fail-closed）。
      const auth = row ? await this.resolveAuth(row) : undefined;
      const result = await this.worker({
        codeGraphId,
        serviceId,
        teamId,
        repoUrl,
        branch,
        auth,
        dir: this.dirFor(serviceId, teamId, codeGraphId),
        setInternalStatus: (s) =>
          this.store.updateCodeGraphStatus(serviceId, codeGraphId, { status: "processing", internal_status: s }),
      });
      // 结束前检查点：processing 期间被删 → 跳过 ready/audit/回调，做幂等收尾清理。
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        commit_hash: result.commitHash ?? null,
        stats_json: result.stats ? JSON.stringify(result.stats) : null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (synced) {
        this.audit(synced, "ready", result.stats ? JSON.stringify(result.stats) : null);
      }
      this.logger?.info?.(`[code-graph] ${codeGraphId} ready`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, result.stats ?? null);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      // 脱敏：git 报错可能含带凭据 URL，落库/API 返回/TMC 回调前统一替换。
      const msg = redactCredentials(rawMsg);
      // worker 抛错，但若期间已被删，视为取消而非失败：跳过 failed 状态/回调，做清理。
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[code-graph] ${codeGraphId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, null);
    }
  }

  /**
   * worker 检查点判定“已删”后的收尾：幂等清理 worker 可能刚写下的盘/句柄，
   * 并移除 cancelled 标记（该 id 的 worker 到此结束，标记使命完成）。
   */
  private finishCancelled(serviceId: string, teamId: string, codeGraphId: string): void {
    this.cleanupResources(serviceId, teamId, codeGraphId);
    this.cancelled.delete(codeGraphId);
    this.logger?.info?.(`[code-graph] ${codeGraphId} build aborted (deleted during processing)`);
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: CodeGraphRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    stats: { files: number; nodes: number; edges: number } | null,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via template (no LLM for code-graph)
      const { generateCodeGraphSummary } = await import("../callback.js");
      summary = generateCodeGraphSummary(row.repo_name || row.repo_url, row.branch, stats);
      if (summary) {
        this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { summary });
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.code_graph_id,
        service_id: row.service_id,
        type: "code-graph",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
      },
      this.callbackConfig,
    );
  }

  /** 等待后台任务完成（测试 / 停机）。 */
  async onIdle(codeGraphId?: string): Promise<void> {
    await this.queue.onIdle(codeGraphId);
  }
}
