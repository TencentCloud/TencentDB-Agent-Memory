/**
 * SessionStore — L1 in-memory cache for session initialization state.
 *
 * Two-layer persistence:
 *   - L2a: `SessionRepo` — full SessionInitState (30 min pending TTL)
 *   - L2b: `BindingRepo` — minimal id-group binding, used for waking sleeping
 *          conversations (currently permanent under nottl/ prefix)
 *
 * See docs/design/2026-07-10-cos-ttl-nottl-split-plan.md §4.3.
 *
 * ── Identity binding ──────────────────────────────────────────────────────
 * Public API keeps a single `keyId: string` as the L1 map key
 * (historically `${agentSource}:${sessionKey}` from handler.ts). Repo calls
 * however now require `(userId, agentSource, sessionId)`. To avoid rippling
 * that tuple through every `store.set(...)` call site in the session-init
 * state machine, the store maintains a keyId → identity map (`identities`):
 * callers invoke `bind(keyId, identity)` **once** when they have identity in
 * hand, and subsequent `set` / `delete` / `getOrRecover` pull the identity
 * back out. When no identity has been bound (e.g. anonymous / systemUser
 * requests that never rendezvous with auth), repo writes silently no-op.
 *
 * `getOrRecover` also takes an explicit identity param — it's the primary
 * entry point on every turn, so binding-through-that-path is guaranteed.
 */

import type { SessionInitState, SessionInitStatus, SessionInfo, AgentDetail, TaskDetail } from "./types.js";
import { getSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import type { MetadataClient } from "../meta/client.js";
import { isDshRuntimeContextSnapshot } from "../common/user-query-extractor.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Identity tuple used by every Repo call (SessionRepo / BindingRepo).
 *
 * `spaceId` 是 P4 (kernel-sts) 新增字段，用于 STS 权限按 space 隔离时的 key 拼接。
 * 老 caller 不传时视作 `""`（空串），Repo 内部会用 `_default` 兜底段处理。
 */
export interface SessionIdentity {
  userId: string;
  agentSource: string;
  sessionId: string;
  spaceId?: string;
}

/** Extract spaceId from identity, defaulting to `""` for repo helpers. */
function spaceOf(id: SessionIdentity): string {
  return id.spaceId ?? "";
}

/** Context passed to getOrRecover for recovery. */
export interface RecoveryContext {
  /** MetadataClient for kernel agent/task get during recovery. */
  metadataClient?: MetadataClient;
  /** Full message history for fallback recovery via form-envelope scan. */
  messages?: Record<string, unknown>[];
}

export class SessionStore {
  private states = new Map<string, SessionInitState>();
  /** keyId → identity map — populated via {@link bind} to keep repo/binding writes user-namespaced. */
  private identities = new Map<string, SessionIdentity>();
  private ttlMs: number;
  private repo?: SessionRepo;
  private bindingRepo?: BindingRepo;
  private recoveryInFlight = new Map<string, Promise<SessionInitState | undefined>>();

  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    repo?: SessionRepo,
    bindingRepo?: BindingRepo,
  ) {
    this.ttlMs = ttlMs;
    this.repo = repo;
    this.bindingRepo = bindingRepo;
  }

  /** Attach BindingRepo late (called after Redis / storage activation). */
  setBindingRepo(repo: BindingRepo): void {
    this.bindingRepo = repo;
  }

  /**
   * 让 skill/memory bridge 拿到同一份 BindingRepo 实例。
   *
   * bridge L2 fallthrough 从这里拿 —— 保证 injection pipeline 装配时的 Kv/Redis
   * 实例、单元测试注入的 mock 都能被 bridge 直接读到,不用重新构造。
   */
  getBindingRepo(): BindingRepo | undefined {
    return this.bindingRepo;
  }

  /**
   * Associate a keyId with a full (userId, agentSource, sessionId) identity so
   * that later {@link set} / {@link delete} / {@link getOrRecover} calls can
   * route writes to `SessionRepo` / `BindingRepo` in the correct namespace.
   *
   * Callers with identity in hand (handler.ts, session-init entry points,
   * hydrateFromDb) invoke this once per keyId. Anonymous callers or L1-only
   * consumers (e.g. skill-bridge's `store.get`) can skip binding — the store
   * silently degrades to memory-only for such keys.
   */
  bind(keyId: string, identity: SessionIdentity): void {
    this.identities.set(keyId, identity);
  }

  /** Test-only helper: expose the identity map for assertions. */
  getBoundIdentity(keyId: string): SessionIdentity | undefined {
    return this.identities.get(keyId);
  }

  get(keyId: string): SessionInitState | undefined {
    const state = this.states.get(keyId);
    if (!state) return undefined;

    if (state.status !== "initialized" && Date.now() - state.startedAt > this.ttlMs) {
      this.states.delete(keyId);
      const id = this.identities.get(keyId);
      if (id) this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
      return undefined;
    }

    return state;
  }

  /**
   * 把 recovery source 挂到 state 的**非可枚举**字段上——handler 侧读取
   * `state.__recoverySource` 语义不变，但 `deepEqual` / `JSON.stringify` /
   * `Object.keys` 都不会看到这一枚 transient marker，避免测试断言"恢复后
   * state 与原 state 完全等价"因新增字段挂掉。
   */
  private tagRecoverySource<T extends SessionInitState>(
    state: T,
    src: NonNullable<SessionInitState["__recoverySource"]>,
  ): T {
    const copy = { ...state } as T;
    Object.defineProperty(copy, "__recoverySource", {
      value: src,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return copy;
  }

  /**
   * L1 write + L2a await write-through + L2b fire-and-forget binding。
   *
   * ⚠ 契约：`await store.set(...)` 完成时，L2a repo 已被 await（成功或静默失败）。
   * 见 2026-07-13 修复：原来 fire-and-forget 语义在多节点部署下会让 pod A
   * 关流时 COS PUT 还在飞，pod B 的 turn-2 因 L2a miss 直接掉进 tryHistoryScan
   * 兜底 → bypass → 请求透传 LLM。
   *
   * L2b binding 仍是 fire-and-forget —— 只在 `initialized` 状态写入，属于
   * "小纸条"型持久化，用于长睡对话唤醒；写延迟不影响 pending 状态跨节点恢复。
   */
  async set(keyId: string, state: SessionInitState): Promise<void> {
    // `__recoverySource` is a transient hint produced by getOrRecover() only,
    // and must not leak into L1/L2a/L2b persistence. Strip it defensively here
    // so future callers who forward a getOrRecover() result into set() don't
    // pollute the repo (业务 caller 目前都从 store.get() 拿 state，本身没有该
    // 字段；这里是最后一道兜底).
    if (state.__recoverySource !== undefined) {
      const { __recoverySource: _drop, ...clean } = state;
      void _drop;
      state = clean as SessionInitState;
    }
    // resetFlow / resetEpoch 自动继承 —— pre-hook 写入这两个字段后,form 流程会
    // 经过多次 state 转换（pending_asset_confirm → pending_team_select → ...）,
    // 每次转换点若手工 new 一个 state 对象很容易漏掉这俩字段,导致 completeRegistration
    // 拿到 resetFlow=undefined,handler 侧就无法识别"这是 reset 引导的完成回合"→
    // 请求被透传给 LLM 产生幻觉响应。
    // 保守做法：只在新 state 未显式声明这俩字段（值为 undefined）时,从旧 state
    // 继承一次。显式传 false / 具体值的 caller 不会被覆盖。
    const prev = this.states.get(keyId);
    if (prev) {
      if (state.resetFlow === undefined && prev.resetFlow !== undefined) {
        state = { ...state, resetFlow: prev.resetFlow };
      }
      if (state.resetEpoch === undefined && prev.resetEpoch !== undefined) {
        state = { ...state, resetEpoch: prev.resetEpoch };
      }
    }
    this.states.set(keyId, state);
    const id = this.identities.get(keyId);
    if (!id) {
      // No identity bound → this keyId is L1-only (anonymous session, tests
      // that bypass bind, etc.). Skip repo/binding persistence rather than
      // fabricating a partial identity.
      return;
    }
    // L2a write-through —— MUST await；见方法头注释。
    // 二次防御性 catch：契约要求实现方（KvSessionRepo / RedisSessionRepo /
    // SqliteSessionRepo）内部静默降级不抛，但接口层再兜一层，保证任何后来
    // 新增的 repo 或 test-mock 都不会把异常泄给 44 处 `await store.set(...)`
    // caller —— L1 已成功写入，主流程不因 L2a 写失败挂掉。
    if (this.repo) {
      try {
        await this.repo.upsert(spaceOf(id), id.userId, id.agentSource, id.sessionId, state);
      } catch (err) {
        console.warn(
          `[session] L2a upsert failed for ${keyId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    // L2b: only write binding on terminal states
    // await 而非 fire-and-forget，保持与 L2a 一致的契约：
    // `await store.set(...)` return 时，L1 / L2a / L2b 三层都已 durable。
    // 每个 session 只会在初始化终态触发一次，成本可控。
    if (state.status === "initialized" && this.bindingRepo) {
      // agentSource / userKey 现在存进 binding 内部字段(不再在 key 里),
      // 让 bridge 只凭 (spaceId, sessionId) 就能反查回完整身份。
      // 见 docs/design/2026-08-03-binding-flatten.md。
      const binding: SessionBinding = state.bypassed
        ? {
            outcome: "bypassed",
            userId: state.userId,
            teamId: state.sessionInfo?.team_id,
            agentId: state.sessionInfo?.agent_id,
            taskId: state.sessionInfo?.task_id,
            agentSource: id.agentSource,
            userKey: state.sessionInfo?.user_key,
          }
        : {
            outcome: "initialized",
            userId: state.sessionInfo?.user_id || state.userId,
            teamId: state.sessionInfo?.team_id,
            agentId: state.sessionInfo?.agent_id,
            taskId: state.sessionInfo?.task_id,
            agentSource: id.agentSource,
            userKey: state.sessionInfo?.user_key,
          };
      try {
        await this.bindingRepo.putBinding(spaceOf(id), id.sessionId, binding);
      } catch (err) {
        console.warn(
          `[session] L2b binding write failed for ${keyId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  delete(keyId: string): void {
    this.states.delete(keyId);
    const id = this.identities.get(keyId);
    if (!id) return;
    this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
    void this.bindingRepo
      ?.deleteBinding(spaceOf(id), id.sessionId)
      .catch(() => {});
  }

  getStatus(keyId: string): SessionInitStatus {
    return this.get(keyId)?.status ?? "uninitialized";
  }

  cleanup(): void {
    const now = Date.now();
    for (const [keyId, state] of this.states) {
      if (state.status !== "initialized" && now - state.startedAt > this.ttlMs) {
        this.states.delete(keyId);
        const id = this.identities.get(keyId);
        if (id) this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
      }
    }
  }

  async hydrateFromDb(): Promise<number> {
    if (!this.repo) return 0;
    try {
      const rows = await this.repo.loadAllInitialized();
      let loaded = 0;
      for (const row of rows) {
        // L1 key convention matches handler.ts / init.ts entry sites:
        //   `${agentSource}:${sessionId}`
        // Also bind full identity so subsequent set() persists back through
        // the correct (userId, agentSource, sessionId) key path.
        const keyId = `${row.agentSource}:${row.sessionId}`;
        if (!this.states.has(keyId)) {
          this.states.set(keyId, row.state);
          this.identities.set(keyId, {
            userId: row.userId,
            agentSource: row.agentSource,
            sessionId: row.sessionId,
            spaceId: row.spaceId || undefined,
          });
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[session-db] hydrated ${loaded} initialized session(s) from disk`);
      }
      return loaded;
    } catch (err) {
      console.warn(
        "[session-db] hydrateFromDb failed:",
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    }
  }

  // ── Recovery layer ──────────────────────────────────────────────────────────

  /**
   * Get session state, or attempt recovery from L2b binding if hot cache missed.
   *
   * Returns undefined when the session should be treated as truly new
   * (caller then invokes handleSessionInit to pop the form).
   *
   * Recovery chain: L1 → L2a → L2b (kernel fetch) → history-scan fallback.
   */
  async getOrRecover(
    keyId: string,
    identity: SessionIdentity,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Bind identity for downstream set()/delete()/probeL2a callchain.
    this.identities.set(keyId, identity);

    // Step 1: L1
    //
    // ⚠ Terminal 状态（`initialized`，含 `bypassed`）L1 才权威 —— 一旦定型
    // 不会再改；pending_* 状态**不能**在 L1 命中就短路，否则会踩到多节点跨
    // pod 陈旧读 bug（2026-07-14）：
    //   turn-1 打 pod A → 写 L1(A)=pending_asset_confirm + L2a
    //   turn-2 打 pod B → L2a probe 读到 pending_asset_confirm → advance 到
    //                     pending_agent_select → 写 L1(B) + L2a
    //   turn-3 又打 pod A → L1(A) 仍然是 pending_asset_confirm（pod 间无
    //                       cache-invalidation 通知）→ 若这里短路就用陈旧
    //                       state 去处理 turn-3 的 agent 答复 → extract 拿
    //                       "agent 选项文本" 去 asset_confirm 分支 →
    //                       unrecognized → session bypass → 请求原样透传给
    //                       LLM（用户观感：不选 task 就走了）。
    //
    // 修法：pending_* 无论 L1 是否命中，都必须走 probeL2a 拿权威值；probeL2a
    // 内部会 promote 覆盖 L1，之后 init.ts 的 `store.get(compositeKey)` 就能
    // 读到最新状态。L1 pending 命中作为 L2a 失败/miss 时的 last-resort fallback
    // 保留（见 Step 2 后的分支），保证同 pod 场景下 L2a 尚未落盘时不倒退。
    //
    // 代价：每轮多一次 storage GET（~50ms COS）。
    // 多节点无状态设计：L1 仅作为 L2a miss 时的降级 fallback（COS 抖动），
    // 不作为权威源。session-reset 可能在任意 pod 执行，L1 initialized 不可信。
    const l1 = this.get(keyId);
    // 不对 initialized 做 L1 短路 —— 一律走 L2a 拿权威状态。

    // Step 2: L2a SessionRepo (Redis / SQLite / ProxyStorage) — full SessionInitState.
    // Startup `hydrateFromDb()` covers the single-node case, but in multi-node
    // deployments a session initialized on node A won't be in node B's L1.
    // Without this probe every such request falls through to L2b + a fresh
    // `metadataClient.getAgent/getTask` roundtrip, even though the full
    // agentDetail/taskDetail is sitting in the storage layer. Pending 状态也
    // 必须命中就返回 —— 见上面 Step 1 的多节点陈旧 L1 注释。
    if (this.repo) {
      const l2a = await this.probeL2a(keyId, identity);
      if (l2a) {
        // 只有 L1 存在**且**status 不同才算真"override stale L1"。相同 status
        // 只是 L2a 权威读回来复核一遍，属正常路径（pending_* 每轮都会走 L2a
        // probe），日志里没必要拉警报，之前的无条件 "override stale L1" 会误
        // 导观察者以为有一致性问题。
        const stale = l1 && l1.status !== l2a.status ? " (override stale L1)" : "";
        console.log(`[cache] session=${keyId} L2a hit → promote L1${stale}`);
        return this.tagRecoverySource(l2a, "l2a");
      }
    }

    // Step 2.5: L2a miss 时的 L1 降级兜底。
    //
    // L2a(COS) 抖动 / 短暂不可用时，继续走 L2b 只能拿到 binding（只在
    // initialized 写），最终 `tryHistoryScan` 无条件 bypass —— 反而更糟。
    // 这里回退到 L1 是 "宁可用略旧但可用的状态" 的 graceful degradation。
    //
    // zombie / user-mismatch 已在 `this.get()` 与 `probeL2a` 内部各自 invalidate，
    // 走到这里的 l1 一定是 fresh + user 匹配的。
    if (l1) {
      console.log(`[cache] session=${keyId} L1 fallback (L2a miss, status=${l1.status})`);
      return this.tagRecoverySource(l1, "l1");
    }

    // Step 3: L2b Binding
    if (!this.bindingRepo) {
      console.log(`[cache] session=${keyId} miss (no bindingRepo) → history-scan`);
      const scanned = await this.tryHistoryScan(keyId, identity, ctx);
      return scanned ? this.tagRecoverySource(scanned, "history-scan") : undefined;
    }
    let binding: SessionBinding | null;
    try {
      binding = await this.bindingRepo.getBinding(spaceOf(identity), identity.sessionId);
    } catch {
      binding = null;
    }
    if (!binding) {
      console.log(`[cache] session=${keyId} miss (no binding) → history-scan`);
      const scanned = await this.tryHistoryScan(keyId, identity, ctx);
      return scanned ? this.tagRecoverySource(scanned, "history-scan") : undefined;
    }
    console.log(`[cache] session=${keyId} L2b binding hit outcome=${binding.outcome} → rebuild`);

    // Async touch (refresh 30d TTL, don't await)
    void this.bindingRepo
      .touchLastSeen(spaceOf(identity), identity.sessionId)
      .catch(() => {});

    // Step 3.1: bypassed outcome → construct bypass state
    if (binding.outcome === "bypassed") {
      const state: SessionInitState = {
        status: "initialized",
        keyId,
        startedAt: Date.now(),
        attemptCount: 0,
        bypassed: true,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
      };
      await this.set(keyId, state);
      return this.tagRecoverySource(state, "l2b");
    }

    // Step 3.2: initialized outcome → rebuild via kernel
    const rebuilt = await this.rebuildFromBinding(keyId, identity, binding, ctx);
    return rebuilt ? this.tagRecoverySource(rebuilt, "l2b") : undefined;
  }

  /**
   * L2a probe: read the full SessionInitState (agentDetail / taskDetail
   * included) from `SessionRepo` and, if valid, promote it back to L1.
   *
   * Returns undefined (caller should fall through to L2b) when:
   *   - the repo has no row for this key,
   *   - the stored userId disagrees with the current caller (cached identity
   *     no longer applies — same policy as L2b invalidation; row is dropped),
   *   - the row is a stale pending state past ttl (zombie session from a
   *     crashed node),
   *   - the underlying storage errored (degrade silently, same as elsewhere).
   *
   * Non-terminal statuses (`pending_*`) are ALSO returned so a form flow
   * started on node A can continue on node B.
   */
  private async probeL2a(
    keyId: string,
    identity: SessionIdentity,
  ): Promise<SessionInitState | undefined> {
    let row: SessionInitState | null;
    try {
      row = await this.repo!.getBySessionId(
        spaceOf(identity),
        identity.userId,
        identity.agentSource,
        identity.sessionId,
      );
    } catch (err) {
      // 诊断: probeL2a 报错时也 log，之前静默吞掉导致多节点 L2 miss 无迹可循
      console.log(
        `[cache] session=${keyId} L2a probe error space=${spaceOf(identity)} user=${identity.userId} src=${identity.agentSource} sid=${identity.sessionId}: ${(err as Error).message}`,
      );
      return undefined;
    }
    if (!row) {
      // 诊断: 打出实际用来查的 4 段, 方便对着 COS 里的 key 手工比对
      console.log(
        `[cache] session=${keyId} L2a miss space=${spaceOf(identity)} user=${identity.userId} src=${identity.agentSource} sid=${identity.sessionId}`,
      );
      return undefined;
    }

    // Zombie guard: pending forms past ttl are dropped (mirrors get()'s
    // in-memory ttl policy). Only pending — initialized sessions have no
    // ttl concept (users legitimately come back to old conversations).
    if (
      row.status !== "initialized" &&
      Date.now() - row.startedAt > this.ttlMs
    ) {
      console.log(
        `[session-recover] ${keyId} L2a pending expired (status=${row.status}, age=${Date.now() - row.startedAt}ms), invalidating`,
      );
      try {
        this.repo!.deleteBySessionId(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      } catch {
        /* best-effort */
      }
      return undefined;
    }

    const storedUserId = row.userId ?? row.sessionInfo?.user_id;
    if (storedUserId && identity.userId && storedUserId !== identity.userId) {
      console.log(
        `[session-recover] ${keyId} L2a user mismatch (stored=${storedUserId}, current=${identity.userId}), invalidating`,
      );
      try {
        this.repo!.deleteBySessionId(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      } catch {
        /* best-effort */
      }
      return undefined;
    }

    // Promote back to L1 so subsequent turns don't hit the repo at all.
    this.states.set(keyId, row);
    console.log(
      `[session-recover] ${keyId} L2a hit status=${row.status} (agent=${row.sessionInfo?.agent_id ?? "-"}, task=${row.sessionInfo?.task_id ?? "-"})`,
    );
    return row;
  }

  /** In-flight promise deduplication: same keyId → same rebuild promise. */
  private rebuildFromBinding(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const inFlight = this.recoveryInFlight.get(keyId);
    if (inFlight) return inFlight;
    const p = this.doRebuild(keyId, identity, binding, ctx)
      .finally(() => this.recoveryInFlight.delete(keyId));
    this.recoveryInFlight.set(keyId, p);
    return p;
  }

  private async doRebuild(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Step 4.1: user mismatch → invalidate binding
    if (binding.userId && identity.userId && binding.userId !== identity.userId) {
      console.log(`[session-recover] ${keyId} user mismatch (bound=${binding.userId}, current=${identity.userId}), invalidating`);
      await this.bindingRepo?.deleteBinding(spaceOf(identity), identity.sessionId);
      return undefined;
    }

    if (!ctx.metadataClient) {
      // No client → can't recover, degrade to one-shot bypass
      console.warn(`[session-recover] ${keyId} no metadataClient, one-shot bypass`);
      return {
        status: "initialized", keyId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }

    // Step 4.2: fetch details in parallel
    const [agentR, taskR] = await Promise.allSettled([
      binding.agentId ? ctx.metadataClient.getAgent(binding.agentId) : Promise.resolve(null),
      binding.taskId ? ctx.metadataClient.getTask(binding.taskId) : Promise.resolve(null),
    ]);

    const isNotFound = (e: unknown): boolean =>
      typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;

    let agentDetail: AgentDetail | null = null;
    let taskDetail: TaskDetail | null = null;
    let agentNotFound = false;
    let taskNotFound = false;
    let anyKernelError = false;

    if (agentR.status === "fulfilled") {
      if (agentR.value) {
        agentDetail = {
          id: agentR.value.agent_id,
          name: agentR.value.name,
          description: agentR.value.description ?? undefined,
          prompt: agentR.value.prompt ?? undefined,
        };
      }
    } else {
      if (isNotFound(agentR.reason)) agentNotFound = true;
      else anyKernelError = true;
    }
    if (taskR.status === "fulfilled") {
      if (taskR.value) {
        taskDetail = {
          id: taskR.value.task_id,
          name: taskR.value.title,
          description: taskR.value.description ?? undefined,
        };
      }
    } else {
      if (isNotFound(taskR.reason)) taskNotFound = true;
      else anyKernelError = true;
    }

    // Step 4.3: dispatch
    if (agentNotFound) {
      console.log(`[session-recover] ${keyId} agent ${binding.agentId} not found, deleting binding`);
      await this.bindingRepo?.deleteBinding(spaceOf(identity), identity.sessionId);
      return undefined;
    }
    if (anyKernelError) {
      console.warn(`[session-recover] ${keyId} kernel unavailable, one-shot bypass`);
      // Don't delete binding; return one-shot bypass to serve this request
      return {
        status: "initialized", keyId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }
    if (taskNotFound) {
      console.log(`[session-recover] ${keyId} task ${binding.taskId} not found, keeping agent`);
      // Update binding to drop taskId
      await this.bindingRepo?.putBinding(
        spaceOf(identity),
        identity.sessionId,
        { ...binding, taskId: undefined },
      );
      taskDetail = null;
    }

    // Step 4.4: construct rebuilt state
    // user_key / space_id 从 binding 恢复(2 段拍平后 binding 里也存了),
    // 让 bridge L2 fallthrough 恢复出的 SessionInfo 字段完整,memory-bridge
    // 恢复 chat_memory 检索时不再降级为 self-only。
    const sessionInfo: SessionInfo = {
      session_id: identity.sessionId,
      user_id: binding.userId || identity.userId,
      team_id: binding.teamId || "",
      agent_id: binding.agentId || "",
      task_id: taskDetail ? binding.taskId : undefined,
      user_key: binding.userKey,
      space_id: identity.spaceId,
      created_at: new Date().toISOString(),
    };

    const rebuilt: SessionInitState = {
      status: "initialized",
      keyId,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: binding.userId,
      agentDetail,
      taskDetail,
    };

    // Step 4.5: write back to L1 + L2a
    this.states.set(keyId, rebuilt);
    // await write-through 与 SessionStore.set 保持一致契约（见其头注释）：
    // 让恢复出的 rebuilt 状态在返回前已落 L2a，避免同 session 后续轮次
    // 若又打到别的 pod 时再走一次 rebuildFromBinding 的开销。
    // 防御性 catch 见 `set()` 头注释。
    if (this.repo) {
      try {
        await this.repo.upsert(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId, rebuilt);
      } catch (err) {
        console.warn(
          `[session-recover] L2a upsert failed for ${keyId} during rebuild: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    console.log(`[session-recover] ${keyId} rebuilt from binding (agent=${binding.agentId}, task=${binding.taskId ?? "-"})`);

    return rebuilt;
  }

  /**
   * Last-resort fallback: when L2b binding is also missing but the conversation
   * has multiple user messages, scan the history for session-init form envelopes
   * to determine whether this was a bypassed session or had chosen agent/task.
   *
   * - 0-1 user messages + no assistant/tool → truly new
   * - has form markers → attempt to extract agent/task from them
   * - has history but no markers → one-shot bypass (don't re-pop the form)
   */
  private async tryHistoryScan(
    keyId: string,
    identity: SessionIdentity,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const messages = ctx.messages ?? [];
    if (messages.length === 0) return undefined;

    // Count user messages and check for assistant/tool existence.
    // dsh (deepseek-harness) 首帧 body 里塞 3 条**非用户输入**的 role=user 元数据:
    //   - <system-reminder> 工作区指令
    //   - "Current runtime context." 快照
    //   - <available_skills> 列表
    // 若原样计数 userCount>1 会把 dsh 首帧误判为"有历史",触发 markerless
    // one-shot bypass,session-init form 永远不弹。这里跳过 dsh 元数据 user 消息,
    // 只计"真用户输入"。见 docs/dsh-recon/2026-08-14-dsh-capture-analysis.md §2.3。
    let userCount = 0;
    let hasAssistantOrTool = false;
    for (const m of messages) {
      const role = (m.role as string) ?? "";
      if (role === "assistant" || role === "tool") {
        hasAssistantOrTool = true;
        continue;
      }
      if (role !== "user") continue;
      // dsh 元数据签名:content 是 str 且以已知锚点开头(dsh 内部固定文本)。
      // 只在有明确签名时跳过,避免误伤客户端真用户输入。
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") {
        if (
          c.startsWith("<system-reminder>") ||
          isDshRuntimeContextSnapshot(c) ||
          c.startsWith("<system-reminder>\nA skill is a reusable")
        ) {
          continue;
        }
      }
      userCount++;
    }

    // Truly fresh: only one user message, no conversation yet
    if (userCount <= 1 && !hasAssistantOrTool) return undefined;

    // Has conversation history — try to scan for form envelope
    let foundBypass = false;
    let foundAgentId: string | undefined;
    let foundTaskId: string | undefined;

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const content = m.content;
      if (typeof content !== "string") {
        // Anthropic: content array
        if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type !== "tool_use") continue;
            if (typeof block.name !== "string") continue;
            // Look for AskUserQuestion with our session-init prefix
            if ((block.id as string)?.startsWith?.("toolu_cc_session_init_")) {
              const input = block.input as Record<string, unknown> | undefined;
              const question = (input?.question as string) ?? "";
              const options = input?.options as string[] | undefined;
              if (question.includes("关联") || question.includes("资产")) {
                // asset_confirm form — check if the next user message said "否"
                continue; // defer to extractAssetConfirm logic via bypass detection
              }
              if (options?.includes("否，本次不关联") || options?.includes("跳过") || question.includes("SKIP")) {
                foundBypass = true;
              }
              if (question.includes("agent") || question.includes("Agent")) {
                for (const o of options ?? []) {
                  const m = o.match(/^(.+)\s\(([^)]+)\)$/);
                  if (m) foundAgentId = m[2];
                }
              }
            }
          }
        }
        continue;
      }
      // CodeBuddy: <question_answer> XML in string content
      if (!content.includes("<question_answer")) continue;
      // Check for asset_confirm bypass markers in the assistant form message
      if (content.includes("否，本次不关联") || content.includes("本次不关联")) {
        foundBypass = true;
      }
      // Extract agent_id from <question_item id="agent">
      const agentIdMatch = content.match(/<question_item\s+id="agent"[^>]*>[^<]*<\/question_item>/);
      if (agentIdMatch) {
        const valueMatch = agentIdMatch[0].match(/<value>([^<]+)<\/value>/);
        if (valueMatch) foundAgentId = valueMatch[1];
      }
    }

    if (!foundAgentId) {
      // 无论是"历史里选了否"还是"完全没有 form marker"，只要无法恢复 agent
      // 身份就视为未初始化 → 返回 undefined 让上层走 session-init 弹表单。
      // 与 mem:session-reset 语义对齐：session 未 initialized = 必须 init。
      console.log(`[session-recover] ${keyId} history scan → no agent marker, treating as uninitialized`);
      return undefined;
    }

    // Found agent_id in history — try kernel rebuild (same as L2b hit path)
    console.log(`[session-recover] ${keyId} history scan → agent=${foundAgentId} found in form, attempting rebuild`);
    const binding: SessionBinding = {
      outcome: "initialized",
      userId: identity.userId,
      agentId: foundAgentId,
      taskId: foundTaskId,
    };
    return this.rebuildFromBinding(keyId, identity, binding, ctx);
  }
}

/** Global singleton (reset on process restart). */
let _store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!_store) {
    let repo: SessionRepo | undefined;
    try {
      repo = getSessionRepo();
    } catch (err) {
      console.warn(
        "[session-db] session repo unavailable, running memory-only:",
        err instanceof Error ? err.message : String(err),
      );
    }
    _store = new SessionStore(DEFAULT_TTL_MS, repo);
    void _store.hydrateFromDb();
  }
  return _store;
}

/** Reset the singleton — tests only. */
export function __resetSessionStoreForTests(): void {
  _store = null;
}
