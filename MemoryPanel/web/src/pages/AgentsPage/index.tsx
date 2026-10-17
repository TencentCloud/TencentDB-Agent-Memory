import { useAuthStore } from '@/stores/auth';
import { useCurrentRole } from '@/services/useCurrentRole';
import TeamManagementPanel from '@/components/team/TeamManagementPanel';

export function AgentsPage() {
  const { auth } = useAuthStore();
  const role = useCurrentRole();
  if (!auth) return null;

  return (
    <TeamManagementPanel
      currentUser={auth.user_id}
      instanceId={auth.instance_id}
      isAdmin={role === 'admin'}
      section="agents"
    />
  );
}
