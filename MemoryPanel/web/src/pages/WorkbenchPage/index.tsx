/**
 * WorkbenchPage — 任务看板页面
 *
 * ConsoleLayout 已提供 Content + Content.Body 包裹，页面只需渲染内容。
 */
import { useMemo } from 'react';
import { useAuthStore } from '@/stores/auth';
import { useTeams, useAgents } from '@/services';
import { useCurrentRole } from '@/services/useCurrentRole';
import TaskWorkbench from './components/TaskWorkbench';

export function WorkbenchPage() {
  const { auth } = useAuthStore();
  const role = useCurrentRole();
  const { activeTeamId } = useTeams();
  const { agents: teamAgentList } = useAgents(activeTeamId);
  const teamAgents = useMemo(
    () => teamAgentList.map((a) => ({ id: a.agent_id, name: a.name })),
    [teamAgentList]
  );

  if (!auth) return null;

  return (
    <TaskWorkbench
      activeTeamId={activeTeamId}
      currentUser={auth.user_id}
      agents={teamAgents}
      isAdmin={role === 'admin'}
    />
  );
}
