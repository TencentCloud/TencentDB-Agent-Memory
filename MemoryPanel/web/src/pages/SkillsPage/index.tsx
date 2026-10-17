import { ResourcePage } from '@/pages/ResourcePage';
import SkillsPanel from './components/SkillsPanel';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole } from '@/services/useCurrentRole';

export function SkillsPage() {
  const { auth } = useAuthStore();
  const role = useCurrentRole();
  if (!auth) return null;

  return (
    <ResourcePage>
      <SkillsPanel currentUser={auth.user_id} isAdmin={role === 'admin'} />
    </ResourcePage>
  );
}
