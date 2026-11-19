import { ResourcePage } from '@/pages/ResourcePage';
import { useTeams } from '@/services';
import CodeSourcesPanel from './components/CodeSourcesPanel';

export function CodePage() {
  const { activeTeamId, activeTeam } = useTeams();
  return (
    <ResourcePage>
      {/* A team's tracked graphs and open dialogs belong to this mount. */}
      <CodeSourcesPanel key={activeTeamId} activeTeamId={activeTeamId} activeTeam={activeTeam} />
    </ResourcePage>
  );
}
