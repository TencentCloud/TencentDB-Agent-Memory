/**
 * /api/v1/agent/delete-cascade —— 删除 agent 时先级联清理该 agent 名下的 skill。
 *
 * 背景（与内核 archiveAgent 的分工）：
 *   - 内核 archiveAgent (metadata-service.ts) 会在同一次调用里顺手归档该 agent 自身的
 *     chat_memory asset + 清其它 agent 借入这块 memory 的绑定；skill 完全不管。
 *   - 结果是：直接调 meta/agent/archive 会留下 owner_agent_id = 被删 agent 的
 *     active skill 脏数据（前端只按 status 过滤，看似消失但表里还在）。
 *
 * 授权（issue #1321：放宽为三档，与内核 delete/archive 的权限面对齐）：
 *   - owner  → owner 路径（1–5）
 *   - team admin / system_admin → admin 路径（6）
 *   前端 canManageAsset 的判定与这里保持一致：它本就放行 owner 与 team admin，
 *   本次一并放行全局 system_admin，消除「按钮可点、点了必 403」的 UI/内核不一致。
 *   为什么必须放宽：成员被移出团队、或用户被删除后，其 Agent 的 owner_user_id 已
 *   无主体可认证 —— admin 旁路是清理这些孤儿 Agent 的唯一通道。
 *
 * owner 路径：
 *   1. auth/verify 反查 caller
 *   2. agent/get 拿到 agent，校验 caller 是 owner
 *   3. skill/list 按 owner_agent_id + active 分页拉全
 *   4. 逐条 skill/delete —— 任一失败立即中断，返回 500 + 已删列表 + 失败 skill_id
 *      + 内核错误 message；此时 agent/archive 不会被调用，caller 需要修复后重试
 *   5. 全部 skill 成功归档后调 meta/agent/archive
 *      —— 内核在同一次 archive 里顺手清 chat_memory（这部分保持原样）
 *
 * admin 路径：
 *   6. 跳过 skill 逐条删除，直接调 meta/agent/delete 硬删除。
 *      为什么不能复用 owner 路径：内核 skill/delete 要求 caller 是 owner_agent 的
 *      owner（skill-permission.assertOwner），admin 过不去；原注释「本期不允许
 *      admin 代删」的限制已随 #1321 取消。代价是 admin 删除时该 agent 名下的 skill
 *      不再逐条清理，改由内核 agent 删除的级联兜底 —— 因此响应里 deleted_skill_ids
 *      恒为空、deleted=true。
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
  okEnvelope,
  readJson,
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

/**
 * 一次 auth/verify 同时拿到 caller 的 user_id 与 system_admin 标记。
 *
 * 原先 resolveCallerUserId + isCallerSystemAdmin 各调一次 auth/verify（同一请求
 * 内重复往返）；本路由两者都要，故合并为一次。
 */
async function resolveCaller(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<{ userId: string; isSystemAdmin: boolean } | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return null;
  const data = env.data as { valid?: boolean; user?: { user_id?: string; user_type?: string } } | null;
  const userId = data?.user?.user_id;
  if (data?.valid !== true || typeof userId !== 'string' || userId.length === 0) return null;
  return { userId, isSystemAdmin: data.user?.user_type === 'system_admin' };
}

/**
 * caller 是否有权管理该 agent（非 owner 时的旁路判定）：
 * system_admin，或该 agent 所属团队的 team admin。
 *
 * 与内核 assertCallerIsAgentOwnerOrTeamAdmin 的判定口径保持一致：
 * team admin 以 team-member 行的 role 为准（team owner 在 createTeam 时即为 admin）。
 * 注意调用方只用本函数判定**非 owner** 的 caller，owner 已在前面短路。
 */
async function callerIsAgentTeamAdmin(
  deps: PanelDeps,
  ctx: MetaCallContext,
  callerId: string,
  agent: AgentRaw,
): Promise<boolean> {
  // team-member/get 要求 caller 是团队成员；非成员会以错误码返回，视为无权。
  const env = await deps.metaKernel.invoke(
    'team-member/get',
    { team_id: agent.team_id, user_id: callerId },
    ctx,
  );
  if (env.code !== 0 || !env.data) return false;
  return (env.data as { role?: string }).role === 'admin';
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

export function registerAgentLifecycleRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/agent/delete-cascade', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    // 1. caller（user_id + system_admin 一次拿到）
    const caller = await resolveCaller(deps, ctx);
    if (!caller) return respondControlError(c, 401, 'INVALID_USER_KEY');
    const { userId: callerId, isSystemAdmin } = caller;

    // 2. agent
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;

    // 3. 授权：owner / team admin / system_admin
    const isOwner = agent.owner_user_id === callerId;
    if (!isOwner) {
      const isAdmin = isSystemAdmin || (await callerIsAgentTeamAdmin(deps, ctx, callerId, agent));
      if (!isAdmin) return respondControlError(c, 403, 'NOT_YOUR_AGENT');

      // 6. admin 路径：跳过 skill 逐条删除，直接硬删除（内核侧 admin 已放行）
      const delEnv = await deps.metaKernel.invoke('agent/delete', { agent_ids: [agentId] }, ctx);
      if (delEnv.code !== 0) return respondEnvelope(c, delEnv);
      return respondEnvelope(
        c,
        okEnvelope(c, {
          archived: false,
          deleted: true,
          agent_id: agentId,
          deleted_skill_count: 0,
          deleted_skill_ids: [],
        }),
      );
    }

    // 4. skill list
    const listRes = await listAgentSkills(deps, ctx, callerId, agent.team_id, agent.agent_id);
    if (!listRes.ok) return respondEnvelope(c, listRes.envelope);
    const skills = listRes.items;

    // 5. 逐条 skill/delete —— 任一失败立即中断，agent 不 archive
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

    // 6'. owner 收尾：agent/archive —— 内核仍然会顺手清 chat_memory
    const archiveEnv = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, ctx);
    if (archiveEnv.code !== 0) return respondEnvelope(c, archiveEnv);

    return respondEnvelope(
      c,
      okEnvelope(c, {
        archived: true,
        deleted: false,
        agent_id: agentId,
        deleted_skill_count: deletedIds.length,
        deleted_skill_ids: deletedIds,
      }),
    );
  });
}
