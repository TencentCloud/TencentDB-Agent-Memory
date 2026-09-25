/**
 * useUsageList — 单请求级用量明细分页（usage/list）。
 *
 * 供下钻抽屉使用：按 model_id 或 user_id 精确过滤（内核支持的两个维度）。
 * enabled 由抽屉可见性 + 当前 Tab 控制，关闭抽屉即停止请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  analyticsApi,
  type AnalyticsRangeDays,
  type UsageLogRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export const USAGE_LIST_PAGE_SIZE = 20;

export function useUsageList(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
  userId?: string;
  modelId?: string;
}) {
  const { enabled, days, spaceId, userId, modelId } = params;

  const [rows, setRows] = useState<UsageLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const seqRef = useRef(0);

  // 过滤条件变化时回到第一页，避免停留在越界 offset
  useEffect(() => {
    setOffset(0);
  }, [days, spaceId, userId, modelId]);

  const query = useMemo(
    () => ({
      days,
      space_id: spaceId,
      user_id: userId || undefined,
      model_id: modelId || undefined,
    }),
    [days, spaceId, userId, modelId],
  );

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.usageList({
        ...query,
        offset,
        limit: USAGE_LIST_PAGE_SIZE,
      });
      if (seq !== seqRef.current) return;
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(getErrorMessage(err));
      setRows([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [query, offset]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return {
    rows,
    total,
    offset,
    limit: USAGE_LIST_PAGE_SIZE,
    loading,
    error,
    setOffset,
    reload: load,
  };
}
