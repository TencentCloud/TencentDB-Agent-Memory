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
 *   3. skill/list 按 owner_agent_id + active 分页拉全
 *      —— 未启用 SkillCore 的部署会拿到内核的「能力缺失」信封
 *      （404 + "Skill module not enabled"），此时按空集合处理，让 archive 继续
 *   4. 逐条 skill/delete —— 任一失败立即中断，返回 500 + 已删列表 + 失败 skill_id
 *      + 内核错误 message；此时 agent/archive 不会被调用，caller 需要修复后重试
 *   5. 全部 skill 成功归档后调 meta/agent/archive
 *      —— 内核在同一次 archive 里顺手清 chat_memory（这部分保持原样）
 *
 * 关于第 3 步的错误分类（issue #1218）：无条件把 skill/list 的失败透传会让
 *「没装 SkillCore」的部署永远删不掉 agent —— 而此时 agent 名下本来就没有
 * skill，级联是空操作。因此只对内核那份精确的「能力缺失」信封放行，其它任何
 * 404 / 错误一律保持 fail-closed，避免吞掉真实错误后留下 active 的孤儿 skill。
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

/**
 * 未启用 SkillCore 时内核返回的「能力缺失」信封 ——
 * MemoryCore/src/gateway/skill-handlers.ts 在 getSkillCore() 取不到实例时固定吐
 * 这两个值。它表达的是「本部署没有这个能力」，而不是「你的请求有问题」。
 */
const SKILL_MODULE_DISABLED_CODE = 404;
const SKILL_MODULE_DISABLED_MESSAGE = 'Skill module not enabled';

/**
 * 是否精确匹配「SkillCore 未启用」。
 *
 * 必须是 code + message 同时相等：内核还有其它 404（参数/路径类），把它们一并
 * 当成「没有 skill」会静默吞掉真实故障，进而把仍然 active 的 skill 留在被归档
 * 的 agent 名下（orphan）。
 */
function isSkillModuleDisabled(env: MetaEnvelope<unknown>): boolean {
  return (
    env.code === SKILL_MODULE_DISABLED_CODE &&
    env.message === SKILL_MODULE_DISABLED_MESSAGE
  );
}

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
    if (env.code !== 0) {
      // 未启用 SkillCore：内核给的是「能力缺失」而不是错误，等价于该 agent 名下
      // 没有 skill —— 按空集合放行，让 archive 走完（issue #1218）。
      //
      // 守卫：只有「一页都没成功拿到」时才这么解释。一旦分页已经跑起来
      // （offset !== 0 或已累积 items），说明上游先返回了数据、之后才报能力缺失，
      // 状态自相矛盾 —— 原样返回信封 fail-closed。否则会把已经观测到的那批 skill
      // 当成不存在直接归档，留下 orphan。
      if (isSkillModuleDisabled(env) && offset === 0 && all.length === 0) {
        return { ok: true, items: [] };
      }
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
