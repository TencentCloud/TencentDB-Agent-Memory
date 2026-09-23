/**
 * usePanelCapabilities / useAnalyticsChConfigured — 「可观测」入口可见性判定。
 *
 * 两层条件（缺一不可）：
 *   1. 面板 env 开关：PANEL_FEATURE_ANALYTICS_ENABLED（随 GET /meta/instances
 *      的 capabilities 下发）。默认关闭 → 菜单/路由不展示，且不发 CH 探测请求。
 *   2. 运行时 CH 探测：开关开启后调 GET /api/v1/analytics/config（面板透明代理
 *      → 内核 /v3/analytics/config）。未配置 ClickHouse 自动隐藏入口。
 *
 * 探测结果均做模块级缓存：env 开关在会话内不变；CH 探测与 AnalyticsPage 页内的
 * useAnalyticsMetrics 探测走同一接口（analyticsApi 内部经 dedupeInFlight 去重），
 * 不会产生重复网络请求。
 */
import { useEffect, useState } from 'react';
import { metaInstancesApi } from '@/lib/api/meta-instances';
import { analyticsApi } from '@/lib/api/analytics';

/** env 开关状态缓存（会话级，null = 尚未取得）。 */
let analyticsEnabledCache: boolean | null = null;

/**
 * 面板「可观测」env 开关。
 * 返回 null 表示尚未取得（渲染方可先按不可见处理或保持现状）；
 * false = 开关关闭或获取失败（保守隐藏）；true = 开关开启（还需过 CH 探测）。
 */
export function usePanelAnalyticsEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(analyticsEnabledCache);

  useEffect(() => {
    if (analyticsEnabledCache !== null) return;
    let alive = true;
    void metaInstancesApi
      .capabilities()
      .then((caps) => {
        analyticsEnabledCache = caps.analyticsEnabled;
        if (alive) setEnabled(caps.analyticsEnabled);
      })
      .catch(() => {
        // 获取失败按关闭兜底（保守隐藏，不阻断面板其他功能）
        analyticsEnabledCache = false;
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return enabled;
}

/**
 * 内核侧 analytics ClickHouse 是否已配置（运行时探测）。
 * 仅在 enabled=true 时发起；null = 探测中（调用方可先按"可见"处理，探测完成后收敛）。
 */
export function useAnalyticsChConfigured(enabled: boolean): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void analyticsApi
      .config()
      .then((cfg) => {
        if (alive) setConfigured(cfg.configured && cfg.reachable !== false);
      })
      .catch(() => {
        // 探测失败（网络/权限）按未配置处理：入口隐藏，页面内提示由 AnalyticsPage 承担
        if (alive) setConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return configured;
}
