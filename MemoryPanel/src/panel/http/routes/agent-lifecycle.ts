/**
 * The kernel owns authorization AND cleanup for all roles. Never impersonate the
 * owner or bypass Skill cleanup for admins. Failed cleanup leaves root metadata
 * available for a retry; disabled SkillCore is handled explicitly in the kernel.
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { buildCtx, okEnvelope, readJson, str } from './knowledge/common.js';

export function registerAgentLifecycleRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/agent/delete-cascade', validatePanelMetaHeaders(deps), async (c) => {
    const agentId = str(await readJson(c), 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    const env = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, buildCtx(c));
    if (env.code !== 0) return respondEnvelope(c, env);
    const data = env.data as { deleted_skill_ids?: string[] } | null;
    const deletedIds = data?.deleted_skill_ids ?? [];
    return respondEnvelope(c, okEnvelope(c, {
      archived: true, agent_id: agentId,
      deleted_skill_count: deletedIds.length, deleted_skill_ids: deletedIds,
    }));
  });
}
