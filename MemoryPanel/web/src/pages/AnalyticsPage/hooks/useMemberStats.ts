/**
 * useMemberStats — 成员维度聚合（面板侧抽样）。
 *
 * 内核无「按成员聚合」的展示接口且本期不改 Core，故对 `tool-calls/list` 分页
 * 采样后在面板侧 GROUP BY user_id。truncated 为 true 时表示采样未覆盖全量，
 * UI 必须标注口径。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { analyticsApi, type AnalyticsRangeDays } from '@/lib/api/analytics';
import { getErrorMessage } from '@/lib/error-message';
import { aggregateByMember, MAX_SAMPLE_PAGES, type MemberStat } from '../utils/member-stats';

export function useMemberStats(params: {
  enabled: boolean;
  days: AnalyticsRangeDays;
  spaceId: string;
}) {
  const { enabled, days, spaceId } = params;

  const [members, setMembers] = useState<MemberStat[]>([]);
  const [sampled, setSampled] = useState(0);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.toolCallSample(
        { days, space_id: spaceId },
        MAX_SAMPLE_PAGES,
      );
      if (seq !== reqSeqRef.current) return;
      setMembers(aggregateByMember(res.rows));
      setSampled(res.rows.length);
      setTotal(res.total);
      setTruncated(res.truncated);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      setError(getErrorMessage(err));
      setMembers([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [days, spaceId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load]);

  return { members, sampled, total, truncated, loading, error, reload: load };
}
