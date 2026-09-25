/**
 * useAnalyticsMetrics — 指标面数据加载（CH 探测 + Space 列表 + 5 项指标）。
 *
 * 数据流约束（勿改回「load 内部再探测 config」）：
 *   config 只探测一次 → 归约为 chReady 布尔 → 由布尔驱动数据加载。
 *   若在 load 内 setConfig，会与以 config 对象为依赖的 effect 形成自激励循环
 *   （fetch 每次返回新引用 → effect 重跑 → 再 setConfig），导致无限请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsApi,
  type AnalyticsRangeDays,
  type BypassReasonRow,
  type EndpointShareRow,
  type SessionInitSummary,
  type SessionTrendRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export type ChState = 'probing' | 'ready' | 'not-configured' | 'unreachable' | 'probe-failed';

export const REFRESH_INTERVAL_MS = 60_000;

export function useAnalyticsMetrics(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
}) {
  const { enabled, days, spaceId } = params;

  const [chState, setChState] = useState<ChState>('probing');

  const [summary, setSummary] = useState<SessionInitSummary | null>(null);
  const [series, setSeries] = useState<SessionTrendRow[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointShareRow[]>([]);
  const [reasons, setReasons] = useState<BypassReasonRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const reqSeqRef = useRef(0);
  const chReady = chState === 'ready';
  const queryBody = useMemo(() => ({ days, space_id: spaceId }), [days, spaceId]);

  // CH 配置探测（仅一次）
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    void (async () => {
      try {
        const cfg = await analyticsApi.config();
        if (!alive) return;
        if (!cfg.configured) setChState('not-configured');
        else if (!cfg.reachable) setChState('unreachable');
        else setChState('ready');
      } catch (err) {
        if (!alive) return;
        setChState('probe-failed');
        setError(getErrorMessage(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled]);

  // 注：不再拉取 /analytics/spaces 全量列表 —— Space 固定为当前登录实例
  // （页面数据面按实例隔离），全量列表会把共享 CH 中其他实例的 space_id
  // 带回前端，既无用也违背隔离语义。

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const [sum, ts, eps, rsns] = await Promise.all([
        analyticsApi.sessionSummary(queryBody),
        analyticsApi.sessionTimeseries(queryBody),
        analyticsApi.endpointShare(queryBody),
        analyticsApi.bypassReasons(queryBody),
      ]);
      if (seq !== reqSeqRef.current) return;
      setSummary(sum);
      setSeries(ts);
      setEndpoints(eps);
      setReasons(rsns);
      setUpdatedAt(new Date());
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [queryBody]);

  useEffect(() => {
    if (!chReady) return;
    void load();
  }, [chReady, load]);

  useEffect(() => {
    if (!chReady) return undefined;
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [chReady, load]);

  return {
    chState,
    chReady,
    summary,
    series,
    endpoints,
    reasons,
    loading,
    error,
    updatedAt,
    reload: load,
  };
}
