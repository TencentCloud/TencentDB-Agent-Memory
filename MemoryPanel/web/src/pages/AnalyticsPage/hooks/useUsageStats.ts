/**
 * useUsageStats — 成本视角数据加载（usage/* 四项 + usage-raw 异常）。
 *
 * 与指标面（useAnalyticsMetrics）分开加载：成本区块位于独立 Tab，只有用户切到
 * 该 Tab（enabled=true）才发请求，避免首屏一次性打出 10+ 个 CH 查询。
 *
 * 口径：全部来自内核 SQL 聚合/分页，均为**全量准确值**，无面板侧抽样。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsApi,
  USAGE_RAW_REASONS,
  type AnalyticsRangeDays,
  type UsageModelRow,
  type UsageRawReason,
  type UsageRawRow,
  type UsageSummary,
  type UsageTrendRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export const USAGE_RAW_PAGE_SIZE = 20;

export type ReasonCounts = Record<UsageRawReason, number>;

const emptyReasonCounts = (): ReasonCounts => ({
  non_tokenhub: 0,
  unknown_model: 0,
  invalid_format: 0,
  invalid_credit: 0,
  report_failed: 0,
});

export function useUsageStats(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
}) {
  const { enabled, days, spaceId } = params;

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [series, setSeries] = useState<UsageTrendRow[]>([]);
  const [models, setModels] = useState<UsageModelRow[]>([]);

  const [rawRows, setRawRows] = useState<UsageRawRow[]>([]);
  const [rawTotal, setRawTotal] = useState(0);
  const [rawOffset, setRawOffset] = useState(0);
  const [rawReason, setRawReason] = useState<UsageRawReason | ''>('');
  const [reasonCounts, setReasonCounts] = useState<ReasonCounts>(emptyReasonCounts);

  const [loading, setLoading] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const seqRef = useRef(0);
  const rawSeqRef = useRef(0);
  const queryBody = useMemo(() => ({ days, space_id: spaceId }), [days, spaceId]);

  // 过滤条件变化时回到第一页，避免停留在越界 offset
  useEffect(() => {
    setRawOffset(0);
  }, [days, spaceId, rawReason]);

  const loadAggregates = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError('');
    try {
      // reason 分级计数：内核无 GROUP BY reason 的聚合接口，故对 5 个枚举各取
      // 一次 total（limit=1，不拉明细）。这是必要的：non_tokenhub 是「非 TokenHub
      // 通道正常留档」而非异常，与真异常混在一起会让总数严重误导。
      const [sum, ts, mds, ...counts] = await Promise.all([
        analyticsApi.usageSummary(queryBody),
        analyticsApi.usageTimeseries(queryBody),
        analyticsApi.usageByModel(queryBody),
        ...USAGE_RAW_REASONS.map((reason) =>
          analyticsApi.usageRawList({ ...queryBody, reason, offset: 0, limit: 1 }),
        ),
      ]);
      if (seq !== seqRef.current) return;
      setSummary(sum);
      setSeries(ts);
      setModels(mds);
      const nextCounts = emptyReasonCounts();
      USAGE_RAW_REASONS.forEach((reason, i) => {
        nextCounts[reason] = counts[i]?.total ?? 0;
      });
      setReasonCounts(nextCounts);
      setUpdatedAt(new Date());
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(getErrorMessage(err));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [queryBody]);

  const loadRaw = useCallback(async () => {
    const seq = ++rawSeqRef.current;
    setRawLoading(true);
    try {
      const res = await analyticsApi.usageRawList({
        ...queryBody,
        reason: rawReason || undefined,
        offset: rawOffset,
        limit: USAGE_RAW_PAGE_SIZE,
      });
      if (seq !== rawSeqRef.current) return;
      setRawRows(res.items);
      setRawTotal(res.total);
    } catch (err) {
      if (seq !== rawSeqRef.current) return;
      // 异常上报表加载失败不应遮蔽主聚合数据，单独提示
      setError(getErrorMessage(err));
      setRawRows([]);
    } finally {
      if (seq === rawSeqRef.current) setRawLoading(false);
    }
  }, [queryBody, rawReason, rawOffset]);

  useEffect(() => {
    if (!enabled) return;
    void loadAggregates();
  }, [enabled, loadAggregates]);

  useEffect(() => {
    if (!enabled) return;
    void loadRaw();
  }, [enabled, loadRaw]);

  const reload = useCallback(() => {
    void loadAggregates();
    void loadRaw();
  }, [loadAggregates, loadRaw]);

  return {
    summary,
    series,
    models,
    rawRows,
    rawTotal,
    rawOffset,
    rawReason,
    reasonCounts,
    rawLimit: USAGE_RAW_PAGE_SIZE,
    loading,
    rawLoading,
    error,
    updatedAt,
    setRawOffset,
    setRawReason,
    reload,
  };
}
