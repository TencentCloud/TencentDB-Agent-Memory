/**
 * useCallDetail — trace 明细分页与过滤。
 *
 * 走内核 `tool-calls/list` 的全量分页（非抽样）。内核支持的过滤维度：
 * user_id（精确）、bridge_source（精确）、executed_endpoint（LIKE 模糊）。
 *
 * wiki / codegraph 同属 knowledge-service，无法只靠 bridge_source 区分，
 * 故由调用方在选中这两类时改用端点关键字（tools/call/）+ 面板侧类别提示。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  analyticsApi,
  type AnalyticsRangeDays,
  type ToolCallRow,
} from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';

export const TRACE_PAGE_SIZE = 20;

export function useCallDetail(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
  userId: string | null;
  bridgeSource: string | undefined;
  endpointFilter: string;
}) {
  const { enabled, days, spaceId, userId, bridgeSource, endpointFilter } = params;

  const [rows, setRows] = useState<ToolCallRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reqSeqRef = useRef(0);

  // 过滤条件变化时回到第一页，避免停留在越界 offset 上显示空列表
  useEffect(() => {
    setOffset(0);
  }, [days, spaceId, userId, bridgeSource, endpointFilter]);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.toolCallList({
        days,
        space_id: spaceId,
        kind: 'bridge_call',
        user_id: userId ?? undefined,
        bridge_source: bridgeSource,
        executed_endpoint: endpointFilter || undefined,
        offset,
        limit: TRACE_PAGE_SIZE,
      });
      if (seq !== reqSeqRef.current) return;
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(getErrorMessage(err));
      setRows([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [days, spaceId, userId, bridgeSource, endpointFilter, offset]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return {
    rows,
    total,
    offset,
    limit: TRACE_PAGE_SIZE,
    loading,
    error,
    setOffset,
    reload: load,
  };
}
