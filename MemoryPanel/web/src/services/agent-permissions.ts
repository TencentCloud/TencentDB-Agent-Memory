/** Agent lifecycle permissions only; do not widen unrelated task/skill editing. */
export function canManageAgentLifecycle(
  agent: { owner_user_id: string; team_id: string },
  team: { team_id: string; owner_user_id: string; members: Array<{ user_id: string; role: string; status?: string }> } | null | undefined,
  userId: string,
  isSystemAdmin = false,
): boolean {
  if (!userId) return false;
  if (isSystemAdmin || agent.owner_user_id === userId) return true;
  if (!team || team.team_id !== agent.team_id) return false;
  return team.members.some((m) => m.user_id === userId && m.role === 'admin' && (m.status === undefined || m.status === 'active'));
}
