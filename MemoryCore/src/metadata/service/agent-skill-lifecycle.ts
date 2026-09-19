import type { SkillCore } from '../../core/skill/skill-core.js';

/** Internal capability, injected only after the metadata service has authorized the lifecycle action. */
export function createAgentSkillLifecycle(
  resolve: () => Promise<Pick<SkillCore, 'list' | 'delete'> | null>,
  deleteAssets: (ids: string[]) => Promise<void>,
) {
  type Target = { teamId: string; agentId: string };
  return {
    async ownedAssetIds({ teamId, agentId }: Target): Promise<string[]> {
      const core = await resolve();
      if (!core) return []; // SkillCore explicitly disabled; no network-404 guessing.
      const ids: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await core.list({ team_id: teamId, agent_id: agentId, filters: { status: ['active', 'archived'] }, pagination: { limit: 100, offset } });
        if (page.items.some((s) => s.owner_agent_id !== agentId || s.team_id !== teamId)) throw new Error('skill ownership scope mismatch');
        ids.push(...page.items.map((s) => s.skill_id));
        if (!page.items.length || ids.length >= page.total) return ids;
      }
    },
    async clean({ teamId, agentId }: Target): Promise<string[]> {
      const core = await resolve();
      if (!core) return [];
      const deleted: string[] = [];
      const seen = new Set<string>();
      for (;;) {
        const page = await core.list({ team_id: teamId, agent_id: agentId, filters: { status: ['active', 'archived'] }, pagination: { limit: 100, offset: 0 } });
        if (!page.items.length) return deleted;
        for (const skill of page.items) {
          if (skill.owner_agent_id !== agentId || skill.team_id !== teamId) throw new Error('skill cleanup scope mismatch');
          if (seen.has(skill.skill_id)) throw new Error('skill cleanup made no progress');
          seen.add(skill.skill_id);
          // SkillCore remains the authoritative retry index until its deletion succeeds.
          // Remove metadata first: a metadata failure must not erase the only discoverable skill ID.
          await deleteAssets([skill.skill_id]);
          try { await core.delete({ team_id: teamId, agent_id: agentId, skill_id: skill.skill_id }, { requireStorageCleanup: true }); }
          catch (err) {
            if ((err as { code?: string }).code !== 'SKILL_NOT_FOUND') throw err;
          }
          deleted.push(skill.skill_id);
        }
      }
    },
  };
}
