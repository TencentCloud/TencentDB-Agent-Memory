/**
 * /api/v1/knowledge/allocate | unbind | agent-fixed | set-visibility | grant
 *
 * req#3 分配：把 knowledge meta_asset 绑定给 agent / 设可见性 / 授权，均走 meta
 * 权威系统（ForCaller）。仿 chat-memory allocate/unbind：list → append/remove → set
 * （agent-fixed-asset 无增量端点）。
 *
 * injection_mode = 'tool'（knowledge 是工具型注入，Proxy 渲染 <knowledge_tools>）。
 */
import type { Hono } from 'hono';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { PanelDeps } from '../../../panel-deps.js';
import {
  buildCtx,
  readJson,
  str,
  okEnvelope,
  extractListItems,
  fetchAllAgentFixedAssetBindings,
  resolveCallerUserId,
  isTeamMember,
  ASSET_TYPE_WIKI,
  ASSET_TYPE_CODE_GRAPH,
} from './common.js';

interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  owner_user_id: string;
  visibility: string;
}
interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
}
interface BindingRaw {
  asset_id: string;
  asset_type: string;
  injection_mode?: string;
  priority?: number;
  created_by?: string;
}

const KNOWLEDGE_ASSET_TYPES = [ASSET_TYPE_WIKI, ASSET_TYPE_CODE_GRAPH];
const VALID_VISIBILITY = ['private', 'team', 'restricted', 'agent', 'task'];

export function registerKnowledgeAllocateRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // 分配：绑定 knowledge asset 给 agent
  api.post('/knowledge/allocate', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const agentId = str(body, 'agent_id');
    const teamId = str(body, 'team_id');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');
    if (!teamId) return respondControlError(c, 400, 'MISSING_TEAM_ID');

    const caller = await resolveCallerUserId(deps, ctx);
    if (!caller) return respondControlError(c, 401, 'INVALID_USER_KEY');
    if (!(await isTeamMember(deps, ctx, teamId, caller))) {
      return respondControlError(c, 403, 'NOT_TEAM_MEMBER');
    }

    const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: knowledgeId }, ctx);
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, 'KNOWLEDGE_NOT_FOUND');
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (!KNOWLEDGE_ASSET_TYPES.includes(asset.asset_type)) {
      return respondControlError(c, 400, 'NOT_KNOWLEDGE_ASSET');
    }
    if (asset.team_id !== teamId) return respondControlError(c, 400, 'TEAM_MISMATCH');

    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId) return respondControlError(c, 400, 'AGENT_NOT_IN_TEAM');

    const bindingResult = await fetchAllAgentFixedAssetBindings<BindingRaw>(deps, ctx, agentId);
    if (bindingResult.error) return respondEnvelope(c, bindingResult.error);
    const bindings = bindingResult.items;
    if (bindings.some((b) => b.asset_id === knowledgeId)) {
      return respondControlError(c, 409, 'ALREADY_ALLOCATED');
    }

    const newBindings = [
      ...bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'summary',
        priority: b.priority ?? 50,
        created_by: b.created_by,
      })),
      { asset_id: knowledgeId, asset_type: asset.asset_type, injection_mode: 'tool', priority: 50, created_by: caller },
    ];
    const setEnv = await deps.metaKernel.invoke('agent-fixed-asset/set', { agent_id: agentId, bindings: newBindings }, ctx);
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(c, okEnvelope(c, { allocated: true, agent_id: agentId, knowledge_id: knowledgeId }));
  });

  // 解绑
  api.post('/knowledge/unbind', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const agentId = str(body, 'agent_id');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    const caller = await resolveCallerUserId(deps, ctx);
    if (!caller) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw | null;
    if (!agent) return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    if (agent.owner_user_id !== caller) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

    const bindingResult = await fetchAllAgentFixedAssetBindings<BindingRaw>(deps, ctx, agentId);
    if (bindingResult.error) return respondEnvelope(c, bindingResult.error);
    const bindings = bindingResult.items;
    const remaining = bindings.filter((b) => b.asset_id !== knowledgeId);
    if (remaining.length === bindings.length) return respondControlError(c, 404, 'BINDING_NOT_FOUND');

    const setEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/set',
      {
        agent_id: agentId,
        bindings: remaining.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? 'summary',
          priority: b.priority ?? 50,
          created_by: b.created_by,
        })),
      },
      ctx,
    );
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(c, okEnvelope(c, { unbound: true, agent_id: agentId, knowledge_id: knowledgeId }));
  });

  // 固定资产 tab：列出 agent 绑定的 wiki / code_graph
  api.post('/knowledge/agent-fixed', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    const isOwner = agent.owner_user_id === meUserId;
    if (!isOwner) {
      const member = await isTeamMember(deps, ctx, agent.team_id, meUserId);
      if (!member) return respondControlError(c, 403, 'NOT_TEAM_MEMBER');
    }
    const applyVisibility = !isOwner;

    const listEnv = await deps.metaKernel.invoke(
      'agent-fixed-asset/list-with-detail',
      { agent_id: agentId, apply_visibility_filter: applyVisibility, touch_usage: false },
      ctx,
    );
    if (listEnv.code !== 0) return respondEnvelope(c, listEnv);

    interface FixedAssetDetailRaw {
      asset_id: string;
      asset_type: string;
      name: string;
      description?: string | null;
      status: string;
      visibility: string;
      created_at: string;
    }
    let items = extractListItems<FixedAssetDetailRaw>(listEnv)
      .filter((it) => KNOWLEDGE_ASSET_TYPES.includes(it.asset_type))
      .filter((it) => it.status !== 'archived' && it.status !== 'deprecated' && it.status !== 'failed');

    if (!isOwner) {
      items = items.filter((it) => it.visibility === 'team');
    }

    const out = items.map((it) => ({
      knowledge_id: it.asset_id,
      asset_type: it.asset_type,
      name: it.name,
      description: it.description ?? null,
      status: it.status,
      visibility: it.visibility,
      agent_id: agentId,
    }));
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // 设可见性（asset/update，ForCaller owner-only 由内核保证）
  api.post('/knowledge/set-visibility', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const visibility = str(body, 'visibility');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!visibility || !VALID_VISIBILITY.includes(visibility)) {
      return respondControlError(c, 400, 'INVALID_VISIBILITY');
    }
    const env = await deps.metaKernel.invoke('asset/update', { asset_id: knowledgeId, visibility }, ctx);
    return respondEnvelope(c, env);
  });

  // 授权（acl/grant，owner-only 由内核保证）
  api.post('/knowledge/grant', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const knowledgeId = str(body, 'knowledge_id');
    const subjectType = str(body, 'subject_type');
    const subjectId = str(body, 'subject_id');
    const permission = str(body, 'permission');
    if (!knowledgeId) return respondControlError(c, 400, 'MISSING_KNOWLEDGE_ID');
    if (!subjectType || !subjectId || !permission) {
      return respondControlError(c, 400, 'MISSING_GRANT_FIELDS');
    }
    const env = await deps.metaKernel.invoke(
      'acl/grant',
      { asset_id: knowledgeId, subject_type: subjectType, subject_id: subjectId, permission },
      ctx,
    );
    return respondEnvelope(c, env);
  });
}
