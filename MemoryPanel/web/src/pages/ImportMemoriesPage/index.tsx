import { useMemo } from 'react';
import { ResourcePage } from '@/pages/ResourcePage';
import { ImportMemoriesPanel } from '../ChatMemoryPage/components/ImportMemoriesPanel';
import { useTeams, useAgents } from '@/stores/backend';

export function ImportMemoriesPage() {
  const { activeTeamId } = useTeams();
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = useMemo(
    () => (teamAgents || []).filter((a) => a.owner_user_id === a.owner_user_id),
    [teamAgents],
  );
  return (
    <ResourcePage>
      <ImportMemoriesPanel
        activeTeamId={activeTeamId}
        agents={ownedTeamAgents.map((a) => ({ agent_id: a.agent_id, name: a.name }))}
      />
    </ResourcePage>
  );
}
