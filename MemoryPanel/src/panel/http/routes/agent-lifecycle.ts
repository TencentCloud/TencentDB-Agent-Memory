/**
 * /api/v1/agent/delete-cascade —— 删除 agent 时先级联清理该 agent 名下的 skill。
 *
 * 背景（与内核 archiveAgent 的分工）：
 *   - 内核 archiveAgent (metadata-service.ts) 会在同一次调用里顺手归档该 agent 自身的
 *     chat_memory asset + 清其它 agent 借入这块 memory 的绑定；skill 完全不管。
 *   - 结果是：直接调 meta/agent/archive 会留下 owner_agent_id = 被删 agent 的
 *     active skill 脏数据（前端只按 status 过滤，看似消失但表里还在）。
 *
 * 本路由的做法（业务级联收口在 control 层，不改内核）：
 *   1. auth/verify 反查 caller
 *   2. agent/get 拿到 agent，校验 caller 是 owner / team admin / system admin
 *   3. skill/list 按 owner_agent_id + active 分页拉全 → 逐条 skill/delete
 *      （owner 与 admin 都走这一步：skill/delete 只校验 (team_id, agent_id) 与
 *       skill 归属匹配、不校验 caller 身份 —— 见 core/skill/skill-permission.ts
 *       assertOwner，历史上的"要求 caller 是 owner"注释是误读）
 *   4a. Owner：meta/agent/archive（软删除，与原有行为一致；内核顺手清 chat_memory）
 *   4b. Admin（team admin / system admin）：meta/agent/delete 硬删除 ——
 *       owner 不可达/已删除时归档只会留下新孤儿；内核 deleteAgents 完整级联
 *       task_agents / fixed_assets / chat_memory，已放行 admin
 *       （与 createAgentForCaller 允许 admin 代建对称）
 *
 * 任一 skill 删除失败立即中断，agent 不会被 archive/delete，返回 500 +
 * 已删列表 + 失败 skill_id，caller 修复后重试。
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import type { MetaCallContext } from '../../kernel/types.js';
import {
  buildCtx,
  extractListItems,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
  isCallerSystemAdmin,
  isTeamAdmin,
} from './knowledge/common.js';

/** skill/list 一页 100 条 —— 与 knowledge fetchAllMetaListItems 分页步长对齐。 */
const SKILL_LIST_PAGE = 100;

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  status?: string;
  name?: string;
}

interface SkillRow {
  skill_id: string;
  version: number;
  owner_agent_id?: string;
}

/** skill/list 分页拉取该 agent 名下所有 active skill。 */
async function listAgentSkills(
  deps: PanelDeps,
  ctx: MetaCallContext,
  callerId: string,
  teamId: string,
  agentId: string,
): Promise<{ ok: true; items: SkillRow[] } | { ok: false; envelope: MetaEnvelope<unknown> }> {
  const all: SkillRow[] = [];
  let offset = 0;
  for (;;) {
    const env = await deps.skillKernel.invoke(
      'list',
      {
        user_id: callerId,
        team_id: teamId,
        agent_id: agentId,
        filters: { status: ['active'] },
        pagination: { limit: SKILL_LIST_PAGE, offset },
      },
      ctx,
    );
    if (env.code !== 0) return { ok: false, envelope: env };
    const batch = extractListItems<SkillRow>(env);
    all.push(...batch);
    const total = (env.data as { total?: number } | null)?.total ?? all.length;
    if (batch.length === 0 || all.length >= total) break;
    offset += SKILL_LIST_PAGE;
  }
  return { ok: true, items: all };
}

/**
 * skill 级联清理：分页拉全 agent 名下 active skill 并逐条删除。
 * owner 与 admin 路径共用 —— skill/delete 的校验对象是 (team_id, agent_id) 与
 * skill 归属的匹配关系，不涉及 caller 身份，admin 代删同样清得干净。
 * 任一删除失败立即中断（返回失败 envelope），agent 保持原状，调用方可重试。
 */
async function deleteAgentSkillsCascade(
  deps: PanelDeps,
  ctx: MetaCallContext,
  callerId: string,
  agent: AgentRaw,
  requestId: string,
): Promise<{ ok: true; deletedIds: string[] } | { ok: false; envelope: MetaEnvelope<unknown> }> {
  const listRes = await listAgentSkills(deps, ctx, callerId, agent.team_id, agent.agent_id);
  if (!listRes.ok) return { ok: false, envelope: listRes.envelope };

  const deletedIds: string[] = [];
  for (const s of listRes.items) {
    const delEnv = await deps.skillKernel.invoke(
      'delete',
      {
        user_id: callerId,
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        skill_id: s.skill_id,
        expected_version: s.version,
      },
      ctx,
    );
    if (delEnv.code !== 0) {
      return {
        ok: false,
        envelope: {
          code: 500,
          message: 'SKILL_DELETE_FAILED',
          request_id: requestId,
          data: {
            failed_skill_id: s.skill_id,
            kernel_code: delEnv.code,
            kernel_message: delEnv.message,
            deleted_skill_ids: deletedIds,
          },
        },
      };
    }
    deletedIds.push(s.skill_id);
  }
  return { ok: true, deletedIds };
}

export function registerAgentLifecycleRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/agent/delete-cascade', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    // 1. caller
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // 2. agent + 权限校验：owner / team admin / system admin
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;

    const isOwner = agent.owner_user_id === callerId;
    let canDelete = isOwner;
    if (!canDelete) canDelete = await isCallerSystemAdmin(deps, ctx);
    if (!canDelete) canDelete = await isTeamAdmin(deps, ctx, agent.team_id, callerId);
    if (!canDelete) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

    // 3. skill 逐条清理（owner / admin 共用）
    const skillRes = await deleteAgentSkillsCascade(deps, ctx, callerId, agent, c.get('reqId') ?? '');
    if (!skillRes.ok) return respondEnvelope(c, skillRes.envelope);
    const { deletedIds } = skillRes;

    // ── Owner：agent/archive（软删除，保留原有行为）──
    if (isOwner) {
      const archiveEnv = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, ctx);
      if (archiveEnv.code !== 0) return respondEnvelope(c, archiveEnv);

      return respondEnvelope(
        c,
        okEnvelope(c, {
          archived: true,
          agent_id: agentId,
          deleted_skill_count: deletedIds.length,
          deleted_skill_ids: deletedIds,
        }),
      );
    }

    // ── Admin：agent/delete 硬删除 ──
    // owner 已不可达（成员被移除/用户被删）或 admin 明确要删，archive 只会留下新孤儿；
    // 完整级联（task_agents, fixed_assets, chat_memory）由内核 deleteAgents 处理。
    const deleteEnv = await deps.metaKernel.invoke('agent/delete', { agent_ids: [agentId] }, ctx);
    if (deleteEnv.code !== 0) return respondEnvelope(c, deleteEnv);

    // 硬删除不用 archived:true 表述（那是软删语义），用 deleted:true + admin_initiated 区分
    return respondEnvelope(
      c,
      okEnvelope(c, {
        deleted: true,
        archived: false,
        agent_id: agentId,
        deleted_skill_count: deletedIds.length,
        deleted_skill_ids: deletedIds,
        admin_initiated: true,
      }),
    );
  });
}
