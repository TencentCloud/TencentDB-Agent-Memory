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
 *   2. agent/get 拿到 agent，强校验 owner_user_id === caller（本期不允许 admin 代删）
 *   3. skill/list 按 owner_agent_id + active 分页拉全；只有内核明确返回
 *      404 "Skill module not enabled" 时，才把 capability 缺失视为没有 skill
 *   4. 逐条 skill/delete —— 任一失败立即中断，返回 500 + 已删列表 + 失败 skill_id
 *      + 内核错误 message；此时 agent/archive 不会被调用，caller 需要修复后重试
 *   5. 全部 skill 成功归档后调 meta/agent/archive
 *      —— 内核在同一次 archive 里顺手清 chat_memory（这部分保持原样）
 *
 * 为什么不做 admin 代删：内核 skill/delete 要求 caller 是 owner_agent 的 owner；
 * admin 代删需要 impersonation 或 control 层拿到 owner 的 user_key，本期先不做。
 *
 * 前端配套：agentsApi.delete 需从 meta/agent/archive 切到本路由；如果要跳过级联走
 * 老逻辑（例如迁移工具），可继续直接调 /api/v1/meta/agent/archive（保留逃生舱）。
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
} from './knowledge/common.js';

/** skill/list 一页 100 条 —— 与 knowledge fetchAllMetaListItems 分页步长对齐。 */
const SKILL_LIST_PAGE = 100;
const SKILL_MODULE_DISABLED_MESSAGE = 'Skill module not enabled';

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

/** Only MemoryCore's explicit capability-absence response is safe to treat as no Skills. */
function isSkillModuleDisabled(env: MetaEnvelope<unknown>): boolean {
  return env.code === 404 && env.message === SKILL_MODULE_DISABLED_MESSAGE;
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
    if (env.code !== 0) {
      if (isSkillModuleDisabled(env)) return { ok: true, items: [] };
      return { ok: false, envelope: env };
    }
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

    // 1. caller
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // 2. agent + owner 强校验
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.owner_user_id !== callerId) {
      return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }

    // 3. skill list
    const listRes = await listAgentSkills(deps, ctx, callerId, agent.team_id, agent.agent_id);
    if (!listRes.ok) return respondEnvelope(c, listRes.envelope);
    const skills = listRes.items;

    // 4. 逐条 skill/delete —— 任一失败立即中断，agent 不 archive
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

    // 5. agent/archive —— 内核仍然会顺手清 chat_memory
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
  });
}
