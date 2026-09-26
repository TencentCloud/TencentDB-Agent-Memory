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
 * 身份边界：入口通过 forIdentity() 获取完整四元组限定的 Store。
 * 视图只固定 identity；L1 与 recovery promise 由根 Store 按完整身份键持有，
 * 因此跨 await 不重绑，也不需要缓存或回收视图对象。
 * 状态机仍使用原 compositeKey，不改变外部会话 ID 或 SessionRepo schema。
 * 未限定身份的内存读写不回退到任何已绑定身份。
 */

import type { SessionInitState, SessionInitStatus, SessionInfo, AgentDetail, TaskDetail } from "./types.js";
import { getSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import type { MetadataClient } from "../meta/client.js";
import { isDshRuntimeContextSnapshot } from "../common/user-query-extractor.js";
import type { PresetIdentity } from "./preset.js";
import { withPerKeyLock } from "../storage/per-key-mutex.js";

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
  return id.spaceId === "_default" ? "" : id.spaceId ?? "";
}

export function sessionIdentityKey(identity: SessionIdentity): string {
  return JSON.stringify([spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId]);
}

function ownsBinding(identity: SessionIdentity, binding: SessionBinding): boolean {
  return binding.userId === identity.userId && binding.agentSource === identity.agentSource;
}

function matchesState(identity: SessionIdentity, state: SessionInitState): boolean {
  return (!state.userId || state.userId === identity.userId)
    && (!state.sessionInfo?.user_id || state.sessionInfo.user_id === identity.userId)
    && (state.sessionInfo?.space_id === undefined
      || spaceOf({ ...identity, spaceId: state.sessionInfo.space_id }) === spaceOf(identity));
}

/** Context passed to getOrRecover for recovery. */
export interface RecoveryContext {
  /** MetadataClient for kernel agent/task get during recovery. */
  metadataClient?: MetadataClient;
  /** Full message history for fallback recovery via form-envelope scan. */
  messages?: Record<string, unknown>[];
  /**
   * Identity pre-parsed from request headers (x-team-id/x-agent-id/x-task-id).
   * When present, history-scan is skipped: header-identity agents (e.g. Pi)
   * carry no interactive form markers, so scanning would unconditionally bypass
   * them. Instead we defer to handleSessionInit (the headerAutoSelect path).
   */
  presetIdentity?: PresetIdentity;
}

export class SessionStore {
  /** L1 状态按完整 identity 隔离；视图本身不参与缓存生命周期。 */
  private states = new Map<string, SessionInitState>();
  private identities = new Map<string, SessionIdentity>();
  private ttlMs: number;
  private repo?: SessionRepo;
  private localBindingRepo?: BindingRepo;
  private root?: SessionStore;
  private identity?: Readonly<SessionIdentity>;
  private recoveryInFlight = new Map<string, Promise<SessionInitState | undefined>>();

  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    repo?: SessionRepo,
    bindingRepo?: BindingRepo,
  ) {
    this.ttlMs = ttlMs;
    this.repo = repo;
    this.localBindingRepo = bindingRepo;
  }

  private get bindingRepo(): BindingRepo | undefined {
    return this.root ? this.root.bindingRepo : this.localBindingRepo;
  }

  forIdentity(identity: SessionIdentity): SessionStore {
    const root = this.root ?? this;
    const view = new SessionStore(root.ttlMs, root.repo);
    view.root = root;
    view.identity = Object.freeze({
      spaceId: spaceOf(identity), userId: identity.userId,
      agentSource: identity.agentSource, sessionId: identity.sessionId,
    });
    return view;
  }

  getIdentity(): Readonly<SessionIdentity> | undefined {
    return this.identity;
  }

  private stateKey(keyId: string): string {
    if (!this.identity) throw new Error("Use forIdentity before accessing a session");
    return this.stateKeyFor(this.identity, keyId);
  }

  private stateKeyFor(identity: SessionIdentity, keyId: string): string {
    return JSON.stringify([spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId, keyId]);
  }

  findSession(spaceId: string, sessionId: string, agentSource?: string, userId?: string): SessionStore | null | undefined {
    const root = this.root ?? this;
    const matches: SessionStore[] = [];
    for (const identity of root.identities.values()) {
      if (spaceOf(identity) !== (spaceId === "_default" ? "" : spaceId)
        || (identity.sessionId !== sessionId && `${identity.agentSource}:${identity.sessionId}` !== sessionId)
        || (agentSource && identity.agentSource !== agentSource)
        || (userId && identity.userId !== userId)) continue;
      const view = root.forIdentity(identity);
      if (view.get(`${identity.agentSource}:${identity.sessionId}`)) matches.push(view);
    }
    return matches.length > 1 ? null : matches[0];
  }

  /** Bridge 没有完整身份：即使 L1 唯一，也必须先排除持久化歧义。null 表示拒绝。 */
  async findBridgeSession(spaceId: string, sessionId: string, repo = this.bindingRepo): Promise<{
    binding: SessionBinding | null;
    sessionId: string;
    l1?: { keyId: string; state: SessionInitState };
  } | null> {
    let scoped = this.findSession(spaceId, sessionId);
    if (scoped === null) return null;
    const bareSessionId = scoped?.getIdentity()?.sessionId ?? sessionId;
    let binding: SessionBinding | null;
    try {
      binding = await repo?.getBinding(spaceId === "_default" ? "" : spaceId, bareSessionId) ?? null;
    } catch {
      return null;
    }
    // 读存储期间可能完成另一个 identity 的初始化，必须重查本机候选。
    scoped = this.findSession(spaceId, sessionId);
    if (scoped === null || binding?.identityAmbiguous) return null;
    const identity = scoped?.getIdentity();
    // composite 别名在 await 期间才进入 L1 时，要改查真正的 bare binding key。
    if (identity && identity.sessionId !== bareSessionId) return this.findBridgeSession(spaceId, identity.sessionId, repo);
    if (identity && binding && !ownsBinding(identity, binding)) return null;
    const keyId = identity ? `${identity.agentSource}:${identity.sessionId}` : "";
    const state = scoped?.get(keyId);
    // 返回校验时的快照；Bridge 在 await 后重新任选 L1 可能选中后来出现的 owner。
    return { binding, sessionId: bareSessionId, l1: state ? { keyId, state } : undefined };
  }

  /** Attach BindingRepo late (called after Redis / storage activation). */
  setBindingRepo(repo: BindingRepo): void {
    (this.root ?? this).localBindingRepo = repo;
  }

  /**
   * 让 skill/memory bridge 拿到同一份 BindingRepo 实例。
   *
   * bridge L2 fallthrough 从这里拿 —— 保证 injection pipeline 装配时的 Kv/Redis
   * 实例、单元测试注入的 mock 都能被 bridge 直接读到,不用重新构造。
   */
  getBindingRepo(): BindingRepo | undefined {
    return this.root ? this.root.getBindingRepo() : this.bindingRepo;
  }

  /** bind 仅校验当前视图的身份；不允许把根 Store 切换为某个用户。 */
  bind(keyId: string, identity: SessionIdentity): void {
    if (!this.identity) {
      throw new Error("Use forIdentity before binding a session");
    }
    if (sessionIdentityKey(this.identity) !== sessionIdentityKey(identity)
      || keyId !== `${identity.agentSource}:${identity.sessionId}`) {
      throw new Error("Session identity mismatch");
    }
    const root = this.root ?? this;
    root.identities.set(this.stateKey(keyId), this.identity);
  }

  /** Test-only helper: expose the identity map for assertions. */
  getBoundIdentity(keyId: string): SessionIdentity | undefined {
    if (!this.identity) return undefined;
    return (this.root ?? this).identities.get(this.stateKey(keyId));
  }

  get(keyId: string): SessionInitState | undefined {
    if (!this.identity) return undefined;
    const root = this.root ?? this;
    const stateKey = this.stateKey(keyId);
    const state = root.states.get(stateKey);
    if (!state) return undefined;
    if (this.identity && !matchesState(this.identity, state)) {
      root.states.delete(stateKey);
      root.identities.delete(stateKey);
      return undefined;
    }

    if (state.status !== "initialized" && Date.now() - state.startedAt > this.ttlMs) {
      root.states.delete(stateKey);
      const id = root.identities.get(stateKey);
      root.identities.delete(stateKey);
      if (id) root.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
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
   * L1 写入 + L2a await write-through + L2b owner 校验后的更新。
   *
   * ⚠ 契约：`await store.set(...)` 完成时，L2a repo 已被 await（成功或静默失败）。
   * 见 2026-07-13 修复：原来 fire-and-forget 语义在多节点部署下会让 pod A
   * 关流时 COS PUT 还在飞，pod B 的 turn-2 因 L2a miss 直接掉进 tryHistoryScan
   * 兜底 → bypass → 请求透传 LLM。
   *
   * L2b 仅在 initialized 时 await 更新：空槽/同主写入 binding，异主保留资产
   * 并追加歧义标记。L2b 单槽未分配给当前 identity 不影响其 L1/L2a 初始化。
   */
  async set(keyId: string, state: SessionInitState): Promise<void> {
    if (!this.identity) return;
    this.bind(keyId, this.identity);
    if (!matchesState(this.identity, state)) {
      throw new Error("Session state identity mismatch");
    }
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
    const root = this.root ?? this;
    const stateKey = this.stateKey(keyId);
    const prev = root.states.get(stateKey);
    if (prev) {
      if (state.resetFlow === undefined && prev.resetFlow !== undefined) {
        state = { ...state, resetFlow: prev.resetFlow };
      }
      if (state.resetEpoch === undefined && prev.resetEpoch !== undefined) {
        state = { ...state, resetEpoch: prev.resetEpoch };
      }
    }
    root.states.set(stateKey, state);
    const id = root.identities.get(stateKey);
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
    if (root.repo) {
      try {
        await root.repo.upsert(spaceOf(id), id.userId, id.agentSource, id.sessionId, state);
      } catch (err) {
        console.warn(
          `[session] L2a upsert failed for ${keyId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    // L2b: only write binding on terminal states
    // await 而非 fire-and-forget，保持与 L2a 一致的契约：
    // 返回前完成 L2a 写入和 L2b owner 检查；存储失败仍遵循既有静默降级契约。
    // 每个 session 只会在初始化终态触发一次，成本可控。
    if (state.status === "initialized" && this.bindingRepo) {
      // agentSource / userKey 现在存进 binding 内部字段(不再在 key 里),
      // 让 bridge 只凭 (spaceId, sessionId) 就能反查回完整身份。
      // 见 docs/design/2026-08-03-binding-flatten.md。
      const binding: SessionBinding = state.bypassed
        ? {
            outcome: "bypassed",
            userId: id.userId,
            teamId: state.sessionInfo?.team_id,
            agentId: state.sessionInfo?.agent_id,
            taskId: state.sessionInfo?.task_id,
            agentSource: id.agentSource,
            userKey: state.sessionInfo?.user_key,
          }
        : {
            outcome: "initialized",
            userId: id.userId,
            teamId: state.sessionInfo?.team_id,
            agentId: state.sessionInfo?.agent_id,
            taskId: state.sessionInfo?.task_id,
            agentSource: id.agentSource,
            userKey: state.sessionInfo?.user_key,
          };
      try {
        await this.updateOwnedBinding(id, current => this.bindingRepo!.putBinding(spaceOf(id), id.sessionId, {
          ...binding, ...(current?.identityAmbiguous ? { identityAmbiguous: true } : {}),
        }), true);
      } catch (err) {
        console.warn(
          `[session] L2b binding write failed for ${keyId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  delete(keyId: string): void {
    if (!this.identity) return;
    const root = this.root ?? this;
    const stateKey = this.stateKey(keyId);
    root.states.delete(stateKey);
    const id = root.identities.get(stateKey);
    root.identities.delete(stateKey);
    if (!id) return;
    root.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
    void this.deleteOwnedBinding().catch(() => {});
  }

  async deleteOwnedBinding(): Promise<void> {
    const identity = this.identity;
    if (identity) await this.updateOwnedBinding(identity, binding => {
      // 只移除自己的资产，歧义事实仍保留；否则重启后的无身份工具会重新猜 owner。
      if (binding?.identityAmbiguous) return this.bindingRepo!.putBinding(spaceOf(identity), identity.sessionId, {
        outcome: "initialized", userId: identity.userId, agentSource: identity.agentSource, identityAmbiguous: true,
      });
      return this.bindingRepo!.deleteBinding(spaceOf(identity), identity.sessionId);
    });
  }

  private async updateOwnedBinding(identity: SessionIdentity, update: (binding: SessionBinding | null) => Promise<void>, allowMissing = false): Promise<void> {
    if (!this.bindingRepo) return;
    await withPerKeyLock(`session-owner:${JSON.stringify([spaceOf(identity), identity.sessionId])}`, async () => {
      const binding = await this.bindingRepo!.getBinding(spaceOf(identity), identity.sessionId);
      if (binding && !ownsBinding(identity, binding)) {
        if (!binding.identityAmbiguous) await this.bindingRepo!.putBinding(spaceOf(identity), identity.sessionId, {
          ...binding, identityAmbiguous: true,
        });
        console.warn("[session] binding owner mismatch; preserving existing binding");
        return;
      }
      if (!binding && !allowMissing) return;
      await update(binding);
    });
  }

  getStatus(keyId: string): SessionInitStatus {
    return this.get(keyId)?.status ?? "uninitialized";
  }

  cleanup(): void {
    const root = this.root ?? this;
    if (root !== this) return root.cleanup();
    const now = Date.now();
    for (const [stateKey, state] of root.states) {
      if (state.status !== "initialized" && now - state.startedAt > this.ttlMs) {
        root.states.delete(stateKey);
        const id = root.identities.get(stateKey);
        root.identities.delete(stateKey);
        if (id) root.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
      }
    }
  }

  async hydrateFromDb(): Promise<number> {
    const root = this.root ?? this;
    if (root !== this) return root.hydrateFromDb();
    if (!root.repo) return 0;
    try {
      const rows = await root.repo.loadAllInitialized();
      let loaded = 0;
      for (const row of rows) {
        if (!matchesState(row, row.state)) continue;
        const keyId = `${row.agentSource}:${row.sessionId}`;
        const stateKey = this.stateKeyFor(row, keyId);
        if (!root.states.has(stateKey)) {
          root.identities.set(stateKey, {
            userId: row.userId, agentSource: row.agentSource,
            sessionId: row.sessionId, spaceId: spaceOf(row),
          });
          root.states.set(stateKey, row.state);
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
    if (!this.identity || sessionIdentityKey(this.identity) !== sessionIdentityKey(identity)) {
      return this.forIdentity(identity).getOrRecover(keyId, identity, ctx);
    }
    this.bind(keyId, identity);
    identity = this.identity!;
    return this.recover(keyId, identity, ctx);
  }

  private async recover(keyId: string, identity: SessionIdentity, ctx: RecoveryContext): Promise<SessionInitState | undefined> {

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
        // 兼容上一版已落盘、尚未记冲突的 Session；不以 L2b 占槽情况阻断 L2a。
        await this.updateOwnedBinding(identity, async () => {}).catch(() => {});
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
    // L1 属于当前完整 identity，不复用其他用户或空间的 fallback。
    if (l1) {
      await this.updateOwnedBinding(identity, async () => {}).catch(() => {});
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
    if (!ownsBinding(identity, binding)) {
      await this.updateOwnedBinding(identity, async () => {}).catch(() => {});
      console.warn(`[session-recover] ${keyId} L2b owner mismatch; reinitialize`);
      return undefined;
    }
    // owner reset 留下的歧义 tombstone 只用于拒绝无身份工具，不可复活旧 Session。
    if (binding.identityAmbiguous && binding.outcome === "initialized" && !binding.agentId) return undefined;
    console.log(`[cache] session=${keyId} L2b binding hit outcome=${binding.outcome} → rebuild`);

    // Async touch (refresh 30d TTL, don't await)
    void this.updateOwnedBinding(identity, () => this.bindingRepo!.touchLastSeen(spaceOf(identity), identity.sessionId)).catch(() => {});

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

    if (!matchesState(identity, row)) {
      console.warn(`[session-recover] ${keyId} L2a identity mismatch, invalidating`);
      try {
        this.repo!.deleteBySessionId(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      } catch {
        /* best-effort */
      }
      return undefined;
    }

    // Promote back to L1 so subsequent turns don't hit the repo at all.
    const root = this.root ?? this;
    const stateKey = this.stateKey(keyId);
    root.identities.set(stateKey, identity);
    root.states.set(stateKey, row);
    console.log(
      `[session-recover] ${keyId} L2a hit status=${row.status} (agent=${row.sessionInfo?.agent_id ?? "-"}, task=${row.sessionInfo?.task_id ?? "-"})`,
    );
    return row;
  }

  /** In-flight promise deduplication: same full identity → same rebuild promise. */
  private rebuildFromBinding(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const root = this.root ?? this;
    const recoveryKey = this.stateKey(keyId);
    const inFlight = root.recoveryInFlight.get(recoveryKey);
    if (inFlight) return inFlight;
    const p = this.doRebuild(keyId, identity, binding, ctx)
      .finally(() => root.recoveryInFlight.delete(recoveryKey));
    root.recoveryInFlight.set(recoveryKey, p);
    return p;
  }

  private async doRebuild(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    if (!ownsBinding(identity, binding)) return undefined;

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
      await this.deleteOwnedBinding();
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
      await this.updateOwnedBinding(identity, current => this.bindingRepo!.putBinding(
        spaceOf(identity),
        identity.sessionId,
        { ...binding, taskId: undefined, ...(current?.identityAmbiguous ? { identityAmbiguous: true } : {}) },
      ));
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
    const root = this.root ?? this;
    const stateKey = this.stateKey(keyId);
    root.identities.set(stateKey, identity);
    root.states.set(stateKey, rebuilt);
    // await write-through 与 SessionStore.set 保持一致契约（见其头注释）：
    // 让恢复出的 rebuilt 状态在返回前已落 L2a，避免同 session 后续轮次
    // 若又打到别的 pod 时再走一次 rebuildFromBinding 的开销。
    // 防御性 catch 见 `set()` 头注释。
    if (root.repo) {
      try {
        await root.repo.upsert(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId, rebuilt);
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
    // Header-identity agents (e.g. Pi) carry identity in request headers, not
    // interactive picker forms — so their history has no form markers and the
    // scan below would unconditionally bypass them. When the caller already
    // parsed a preset identity from headers, defer to handleSessionInit (the
    // headerAutoSelect path) by returning undefined instead of bypassing.
    if (ctx.presetIdentity) {
      console.log(
        `[session-recover] ${keyId} preset identity present → defer to handleSessionInit (skip history-scan)`,
      );
      return undefined;
    }
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
      agentSource: identity.agentSource,
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
