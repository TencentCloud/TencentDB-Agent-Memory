/**
 * useTeamParticipation —— 拉取整个 team 的参与日志，按 task_id 分桶。
 */
import { useCallback, useEffect, useState } from 'react';
import { participationLogsApi } from '@/lib/teamApi';
import type { TaskParticipationView } from '../utils/workbench-utils';

/**
 * 一次请求覆盖列表页 N 个 task 的统计数字（避免 fanout N 次），
 * 详情页也复用同一份数据从 Map 里取。
 *
 * - 数据源：proxy 侧 session init 完成时 append 到内核 `/v3/meta/participation-log/*`
 * - 请求失败降级为空 Map，各处显示 0 / '—'，不阻断其它区域
 * - 追随 BACKEND_REFRESH_EVENT 自动重新拉取
 */
export function useTeamParticipation(teamId: string | null): Map<string, TaskParticipationView> {
  const [byTask, setByTask] = useState<Map<string, TaskParticipationView>>(() => new Map());

  const fetchLogs = useCallback(async () => {
    if (!teamId) {
      setByTask(new Map());
      return;
    }
    try {
      const logs = await participationLogsApi.listByTeam(teamId);
      const buckets = new Map<string, { users: Set<string>; agentIds: Set<string> }>();
      for (const log of logs) {
        if (!log.task_id) continue;
        let bucket = buckets.get(log.task_id);
        if (!bucket) {
          bucket = { users: new Set(), agentIds: new Set() };
          buckets.set(log.task_id, bucket);
        }
        if (log.user_id) bucket.users.add(log.user_id);
        if (log.agent_id) bucket.agentIds.add(log.agent_id);
      }
      const next = new Map<string, TaskParticipationView>();
      for (const [taskId, { users, agentIds }] of buckets) {
        next.set(taskId, { users: [...users], agentIds: [...agentIds] });
      }
      setByTask(next);
    } catch (err) {
      console.warn('[TaskWorkbench] load participation logs failed:', err);
      setByTask(new Map());
    }
  }, [teamId]);

  useEffect(() => {
    let cancelled = false;
    fetchLogs().catch(() => { /* handled inside */ });
    const handler = () => { if (!cancelled) fetchLogs(); };
    window.addEventListener('tdai-memory.backend-refresh', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('tdai-memory.backend-refresh', handler);
    };
  }, [fetchLogs]);

  return byTask;
}
