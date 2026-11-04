import { requireTeamMember } from '../knowledge/common.js';
import type { Hono } from 'hono';
import { isAllowedSkillAction } from '../../../api/skill-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';

/**
 * 从请求路径中解析 skill action。
 * skill action 可能带二级路径（files/write、files/remove、files/read），
 * 故取 `/skill/` 之后的全部片段。
 */
function readAction(path: string): string {
  const marker = '/skill/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/**
 * 注册 skill 数据面透明代理：POST /api/v1/skill/{action} → 内核 POST /v3/skill/{action}。
 *
 * 复用 validatePanelMetaHeaders：对 /skill/* 路径 readAction 返回 ''（非 auth/verify），
 * 因此强制要求 X-Tdai-User-Key，与 skill 需要 owner 身份的语义一致。
 */
export function registerSkillProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/skill/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action || !isAllowedSkillAction(action)) {
      return respondControlError(c, 404, 'UNKNOWN_SKILL_ACTION');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    if (action.startsWith('github/') || action.startsWith('versions/restore')) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.team_id !== 'string' || typeof body.agent_id !== 'string') {
        return respondControlError(c, 400, 'TEAM_AND_AGENT_REQUIRED');
      }
      const caller = await requireTeamMember(deps, c, ctx, body.team_id);
      if ('error' in caller) return caller.error;
      const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: body.agent_id }, ctx);
      const agent = agentEnv.data as { owner_user_id?: string; team_id?: string } | null;
      if (agentEnv.code !== 0 || agent?.team_id !== body.team_id || agent?.owner_user_id !== caller.userId) {
        return respondControlError(c, 403, 'NOT_AGENT_OWNER');
      }
      body.user_id = caller.userId;
    }
    const envelope = await deps.skillKernel.invoke(action, body, ctx);
    return respondEnvelope(c, envelope);
  });
}
