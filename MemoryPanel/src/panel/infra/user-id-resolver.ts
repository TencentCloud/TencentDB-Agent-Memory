/**
 * user_key → user_id 缓存解析器（telemetry 埋点用）。
 *
 * ## 为什么需要
 * `panel_api_call_logs.user_id` 靠 route handler 里 `resolveCallerUserId` 后
 * `c.set('resolvedUserId', ...)` 提供；但绝大多数 route（skill/*、meta/*、
 * knowledge/* 等 60+ 端点）没做这一步 → CH 里 user_id 恒空。
 *
 * ## 设计
 * 中间件层集中兜底：`c.get('resolvedUserId') ?? resolver.get(userKey)`。
 * - **hit**：同步返回缓存的 user_id
 * - **miss**：返回 undefined + fire-and-forget 调 core `auth/verify` 填 cache；
 *   下一条同 user_key 的请求就能命中
 * - **TTL**：5 min（缺省），过期条目 lazy-evict + 主动 refresh
 * - **上限**：默认 5000 条 LRU-ish；超上限从最老开始丢
 * - **零阻塞**：任何路径不会 await 网络 → 埋点永远不影响业务
 *
 * ## 对接点
 * - `panel-deps.ts` 里构造后塞进 PanelDeps
 * - `api-call-telemetry-middleware.ts` 兜底调用
 * - `chat-memory.ts` `/import` 等已 resolve 的 route 走 `c.set` 直接命中，
 *   同时可选调 `warm(userKey, userId)` 预热
 */
import type { MetaKernelPort } from '../kernel/ports/meta-kernel-port.js';
import type { MetaCallContext } from '../kernel/types.js';
import type { Logger } from './logger.js';

export interface PanelUserIdResolverOptions {
  ttlMs: number;
  maxSize: number;
}

const DEFAULT_OPTIONS: PanelUserIdResolverOptions = {
  ttlMs: 5 * 60 * 1000,
  maxSize: 5000,
};

interface CacheEntry {
  userId: string;
  expireAt: number;
}

/**
 * 中间件用到时**必须提供 ctx**（instanceId + gateway 地址等）——
 * 因为 auth/verify 是 per-instance 调用，同一个 user_key 在不同 instance 下
 * 语义不同。resolver 用 `${instanceId}|${userKey}` 作 cache key。
 */
export interface UserIdResolveCtx {
  instanceId: string;
  gatewayEndpoint: string;
  gatewayApiKey: string;
  reqId?: string;
}

export class PanelUserIdResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly refreshInFlight = new Set<string>();
  private readonly options: PanelUserIdResolverOptions;

  constructor(
    private readonly metaKernel: MetaKernelPort,
    private readonly logger: Logger,
    options: Partial<PanelUserIdResolverOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * 同步查询：命中返回 user_id，miss 返回 undefined + 异步刷新。
   * 永不抛异常，永不阻塞。
   */
  get(userKey: string, ctx: UserIdResolveCtx): string | undefined {
    if (!userKey) return undefined;
    const key = this.makeKey(ctx.instanceId, userKey);
    const entry = this.cache.get(key);
    if (entry && entry.expireAt > Date.now()) {
      return entry.userId;
    }
    // miss 或过期 → fire-and-forget refresh
    this.scheduleRefresh(userKey, ctx);
    return undefined;
  }

  /**
   * 显式预热：route 已经调过 auth/verify 拿到 user_id 时，
   * 顺手塞进来省一次 core 调用。
   */
  warm(userKey: string, userId: string, instanceId: string): void {
    if (!userKey || !userId) return;
    const key = this.makeKey(instanceId, userKey);
    this.putEntry(key, userId);
  }

  /** 主动 evict（测试或用户撤销 user_key 时用）。 */
  invalidate(userKey: string, instanceId: string): void {
    this.cache.delete(this.makeKey(instanceId, userKey));
  }

  /** 测试用：当前缓存大小。 */
  size(): number {
    return this.cache.size;
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  private makeKey(instanceId: string, userKey: string): string {
    return `${instanceId}|${userKey}`;
  }

  private scheduleRefresh(userKey: string, ctx: UserIdResolveCtx): void {
    const key = this.makeKey(ctx.instanceId, userKey);
    if (this.refreshInFlight.has(key)) return;
    this.refreshInFlight.add(key);
    void this.refresh(userKey, ctx, key);
  }

  private async refresh(
    userKey: string,
    ctx: UserIdResolveCtx,
    cacheKey: string,
  ): Promise<void> {
    try {
      const metaCtx: MetaCallContext = {
        instanceId: ctx.instanceId,
        gatewayEndpoint: ctx.gatewayEndpoint,
        gatewayApiKey: ctx.gatewayApiKey,
        userKey,
        reqId: ctx.reqId,
      };
      const env = await this.metaKernel.invoke(
        'auth/verify',
        { user_key: userKey },
        metaCtx,
      );
      if (env.code !== 0) return;
      const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
      if (!data?.valid) return;
      const uid = data.user?.user_id;
      if (typeof uid !== 'string' || uid.length === 0) return;
      this.putEntry(cacheKey, uid);
    } catch (err) {
      // 不抛不停,埋点缺 user_id 而已
      this.logger.debug('[user-id-resolver] refresh failed', {
        error: (err as Error).message,
      });
    } finally {
      this.refreshInFlight.delete(cacheKey);
    }
  }

  private putEntry(cacheKey: string, userId: string): void {
    // 超上限先丢最老的一条（Map iteration order = insertion order）
    if (this.cache.size >= this.options.maxSize && !this.cache.has(cacheKey)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, {
      userId,
      expireAt: Date.now() + this.options.ttlMs,
    });
  }
}
