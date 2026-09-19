/**
 * /api/v1/agent/delete-cascade —— 删除 agent 时先级联清理该 agent 名下的 skill。
 *
 * 背景（与内核 archiveAgent 的分工）：
 *   - 内核 archiveAgent (metadata-service.ts) 会在同一次调用里顺手归档该 agent 自身的
 *     chat_memory asset + 清其它 agent 借入这块 memory 的绑定；skill 完全不管。
 *   - 结果是：直接调 meta/agent/archive 会留下 owner_agent_id = 被删 agent 的
 *     active skill 脏数据（前端只按 status 过滤，看似消失但表里还在）。
 *
 * 权限模型（与内核 assertCallerIsAgentOwnerOrTeamAdmin 对齐）：
 *   owner / team admin / system admin 三种主体都可调用，分两条执行路径。
 *
 *   ── owner 路径 ──
 *   1. auth/verify 反查 caller
 *   2. agent/get 拿到 agent，校验 owner_user_id === caller
 *   3. skill/list 按 owner_agent_id + active 分页拉全
 *   4. 逐条 skill/delete —— 任一失败立即中断，返回 500 + 已删列表 + 失败 skill_id
 *      + 内核错误 message；此时 agent/archive 不会被调用，caller 需要修复后重试
 *   5. 全部 skill 成功归档后调 meta/agent/archive
 *      —— 内核在同一次 archive 里顺手清 chat_memory（这部分保持原样）
 *
 *   ── admin 路径（team admin / system admin 代删）──
 *   成员被移出团队、或用户被删除后，其 Agent 会变成 owner_user_id 悬空的孤儿，
 *   owner 已无法认证 —— 之前这里硬性 403「本期不允许 admin 代删」，导致孤儿
 *   Agent 任何角色都删不掉。
 *
 *   现在放宽为：admin 路径**跳过 skill 逐条删除**（内核 skill/delete 仍要求 caller
 *   是 owner_agent 的 owner，无法代删），直接调内核 agent/delete 硬删除本体 ——
 *   内核会级联清 task_agents / agent_fixed_assets / 该 agent 自身的 chat_memory 资产。
 *
 * 前端配套：agentsApi.delete 走本路由；如果要跳过级联走老逻辑（例如迁移工具），
 * 可继续直接调 /api/v1/meta/agent/archive（保留逃生舱）。
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
  isCallerSystemAdmin,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
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
 * 判断 caller 是否是 teamId 的 team admin（team owner 恒为 admin 成员）。
 * 调用方必须已是该 team 成员，否则内核 team-member/get 直接 403 → 保守返回 false。
 */
async function isTeamAdminOf(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const env = await deps.metaKernel.invoke(
    'team-member/get',
    { team_id: teamId, user_id: userId },
    ctx,
  );
  if (env.code !== 0) return false;
  const member = env.data as { role?: string } | null;
  return member?.role === 'admin';
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

    // 2. agent
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;

    // 3. 权限判定：owner / team admin / system admin —— 与内核
    //    assertCallerIsAgentOwnerOrTeamAdmin 保持同一权限面，避免
    //    「UI 渲染删除按钮、点击后 403」的不一致。
    const isOwner = agent.owner_user_id === callerId;
    if (!isOwner) {
      const isSystemAdmin = await isCallerSystemAdmin(deps, ctx);
      const allowed = isSystemAdmin
        || (await isTeamAdminOf(deps, ctx, agent.team_id, callerId));
      if (!allowed) return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }

    // 4. admin 路径：owner 已无法认证（被移出团队 / 用户已被删除），此时 skill 无法代删
    //    （内核 skill/delete 仍要求 caller 是 owner），直接硬删除 agent 本体。
    //    内核 agent/delete 会级联清 task_agents / agent_fixed_assets / chat_memory 资产。
    if (!isOwner) {
      const deleteEnv = await deps.metaKernel.invoke('agent/delete', { agent_ids: [agentId] }, ctx);
      if (deleteEnv.code !== 0) return respondEnvelope(c, deleteEnv);
      return respondEnvelope(
        c,
        okEnvelope(c, {
          mode: 'deleted',
          deleted: true,
          archived: false,
          agent_id: agentId,
          deleted_skill_count: 0,
          deleted_skill_ids: [],
        }),
      );
    }

    // 5. owner 路径：skill list
    const listRes = await listAgentSkills(deps, ctx, callerId, agent.team_id, agent.agent_id);
    if (!listRes.ok) return respondEnvelope(c, listRes.envelope);
    const skills = listRes.items;

    // 6. 逐条 skill/delete —— 任一失败立即中断，agent 不 archive
    const deletedIds: string[] = [];
    for (const s of skills) {
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
        return respondEnvelope(c, {
          code: 500,
          message: 'SKILL_DELETE_FAILED',
          request_id: c.get('reqId') ?? '',
          data: {
            failed_skill_id: s.skill_id,
            kernel_code: delEnv.code,
            kernel_message: delEnv.message,
            deleted_skill_ids: deletedIds,
          },
        });
      }
      deletedIds.push(s.skill_id);
    }

    // 7. agent/archive —— 内核仍然会顺手清 chat_memory
    const archiveEnv = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, ctx);
    if (archiveEnv.code !== 0) return respondEnvelope(c, archiveEnv);

    return respondEnvelope(
      c,
      okEnvelope(c, {
        mode: 'archived',
        archived: true,
        deleted: false,
        agent_id: agentId,
        deleted_skill_count: deletedIds.length,
        deleted_skill_ids: deletedIds,
      }),
    );
  });
}
