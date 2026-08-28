/**
 * grant 控制面拉取（评审意见 4：撤销传播延迟 → 缓存 TTL，默认 60s）。
 *
 * 权威来源在控制面；Proxy 定期拉取授权表并缓存 TTL 秒，撤销后最多延迟
 * 一个 TTL 生效。endpoint 未配置（或拉取失败）时回退静态 fallback 表。
 */
import { log } from "../report/log.js";

export interface GrantsProviderConfig {
  /** 控制面授权接口 URL（GET，返回 [{teamId, agentId}]）。 */
  endpoint?: string;
  /** 拉取间隔（秒），默认 60。 */
  ttlSeconds?: number;
  /** 静态回退授权表（endpoint 未配 / 拉取失败时使用）。 */
  fallback?: Array<{ teamId: string; agentId: string }>;
}

export type GrantsProvider = () => Promise<Array<{ teamId: string; agentId: string }>>;

let cached: Array<{ teamId: string; agentId: string }> = [];
let lastFetch = 0;
let cfg: GrantsProviderConfig | null = null;

/** 幂等初始化（改配置后调用一次刷新）。 */
export function initGrants(config: GrantsProviderConfig | undefined): void {
  cfg = config ?? null;
  cached = config?.fallback ?? [];
  lastFetch = 0;
}

/** 取当前有效授权表（TTL 内命中缓存，过期/首拉则刷新；失败回退缓存/静态表）。 */
export const getGrants: GrantsProvider = async () => {
  if (!cfg?.endpoint) return cached;
  const now = Date.now();
  const ttlMs = (cfg.ttlSeconds ?? 60) * 1000;
  if (cached.length > 0 && now - lastFetch < ttlMs) return cached;
  try {
    const res = await fetch(cfg.endpoint, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = (await res.json()) as Array<{ teamId?: string; agentId?: string }>;
      cached = Array.isArray(data)
        ? data.filter((g) => g?.teamId && g?.agentId).map((g) => ({ teamId: g.teamId!, agentId: g.agentId! }))
        : [];
      lastFetch = now;
      log.info("grants.refreshed", { count: cached.length });
    }
  } catch (err) {
    log.warn("grants.refresh.failed", {
      error: err instanceof Error ? err.message : String(err),
      usingCache: cached.length > 0,
    });
  }
  return cached;
};
