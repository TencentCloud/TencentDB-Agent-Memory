import type { Hono } from 'hono';
import type { MetaAction } from '../../../api/meta-actions.js';
import {
  ALLOWED_PANEL_ACTIONS,
  isNotInScopeAction,
} from '../../../api/meta-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import { KNOWLEDGE_SERVICE_USERNAME } from '../../../startup/ensure-knowledge-llm-binding.js';
import { DEFAULT_SKILLS } from './default-skills.js';

/**
 * Hide the internal per-instance `knowledge-service` billing user from panel user
 * listings (design 009 §4.2). Mutates the envelope's paginated `items`/`total` in place.
 */
function hideKnowledgeServiceUser(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const d = data as { items?: Array<{ username?: string }>; total?: number };
  if (!Array.isArray(d.items)) return;
  const before = d.items.length;
  d.items = d.items.filter((u) => u.username !== KNOWLEDGE_SERVICE_USERNAME);
  const removed = before - d.items.length;
  if (removed > 0 && typeof d.total === 'number') {
    d.total = Math.max(0, d.total - removed);
  }
}

function readAction(path: string): string {
  const marker = '/meta/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

// ── 创建时重复名称检查 ──

interface DupCheckConfig {
  /** 用来查重的 list action。 */
  listAction: string;
  /** 从 create body 构造 list 请求体（限定可见范围）。 */
  listBody: (body: Record<string, unknown>) => Record<string, unknown>;
  /** 内核新增的精确过滤参数名。 */
  filterParam: string;
  /** 从 create body 提取待匹配的值。 */
  matchValue: (body: Record<string, unknown>) => string | undefined;
  /** 中文实体名，用于错误消息。 */
  entityLabel: string;
}

const DUP_CHECK_MAP: Record<string, DupCheckConfig> = {
  'user/create': {
    listAction: 'user/list',
    listBody: () => ({}),
    filterParam: 'username',
    matchValue: (b) => (typeof b.username === 'string' ? b.username : undefined),
    entityLabel: '用户',
  },
  // user/create 的姊妹接口：查重口径与 user/create 完全一致（先按 username 精确 list）。
  // user_key 的重复由内核 duplicate_user_key(409) 兜底，Panel 直接透传。
  'user/create-with-key': {
    listAction: 'user/list',
    listBody: () => ({}),
    filterParam: 'username',
    matchValue: (b) => (typeof b.username === 'string' ? b.username : undefined),
    entityLabel: '用户',
  },
  'team/create': {
    listAction: 'team/list',
    listBody: (b) => ({ user_id: b.owner_user_id }),
    filterParam: 'name',
    matchValue: (b) => (typeof b.name === 'string' ? b.name : undefined),
    entityLabel: '团队',
  },
  'agent/create': {
    listAction: 'agent/list',
    // 面板「删除」走 agent/archive（status→inactive），列表只展示 active；
    // 查重须同样过滤，否则归档后同名重建会被误拦 409。
    listBody: (b) => ({ team_id: b.team_id, owner_user_id: b.owner_user_id, status: 'active' }),
    filterParam: 'name',
    matchValue: (b) => (typeof b.name === 'string' ? b.name : undefined),
    entityLabel: 'Agent',
  },
  'task/create': {
    listAction: 'task/list',
    // 面板删 Task 走物理 task/delete；completed 仍在工作台可见，故查重含全部状态。
    listBody: (b) => ({ team_id: b.team_id, creator_user_id: b.creator_user_id }),
    filterParam: 'title',
    matchValue: (b) => (typeof b.title === 'string' ? b.title : undefined),
    entityLabel: 'Task',
  },
};

/**
 * 对 create 类 action 做"先查后写"重复检查。
 * 返回 null 表示不重复；否则返回中文错误消息。
 */
async function checkDuplicate(
  action: string,
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<string | null> {
  const config = DUP_CHECK_MAP[action];
  if (!config) return null;

  const targetValue = config.matchValue(body);
  if (!targetValue) return null;

  const listBody = {
    ...config.listBody(body),
    [config.filterParam]: targetValue,
    limit: 1,
  };

  try {
    const envelope = await deps.metaKernel.invoke(config.listAction, listBody, ctx);
    if (envelope.code === 0) {
      // 以返回 items 中的精确同名为准；部分内核版本可能暂不支持 name 过滤，
      // 不能因为 items 非空就误判重复。
      const data = envelope.data as { items?: unknown[] } | undefined;
      if (Array.isArray(data?.items)) {
        const duplicated = data.items.some((item) => {
          if (!item || typeof item !== 'object') return false;
          const value = (item as Record<string, unknown>)[config.filterParam];
          return typeof value === 'string' && value === targetValue;
        });
        if (duplicated) {
          return `已存在同名${config.entityLabel}「${targetValue}」，请更换名称后重试。`;
        }
      }
    }
  } catch {
    // 查重失败时放行，宁可允许重复也不错杀正常创建
  }
  return null;
}

// ── 路由注册 ──

export function registerMetaProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/meta/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    if (isNotInScopeAction(action)) {
      return respondControlError(c, 501, 'NOT_IN_SCOPE');
    }

    if (!ALLOWED_PANEL_ACTIONS.has(action as MetaAction)) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
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

    // create 类 action：先查重
    const duplicateMsg = await checkDuplicate(action, body, ctx, deps);
    if (duplicateMsg) {
      return respondControlError(c, 409, duplicateMsg);
    }

    const envelope = await deps.metaKernel.invoke(action, body, ctx);

    // team-member/add 成功后，为默认 Agent 导入预置 Skill（best-effort，异步不阻塞响应）
    if (action === 'team-member/add' && envelope.code === 0) {
      void importDefaultSkillsForNewMember(body, ctx, deps);
    }

    if (action === 'user/list' && envelope.code === 0) {
      hideKnowledgeServiceUser(envelope.data);
    }
    // 切私密后：不再由 backend 主动 prune 其它 agent 的绑定。
    // 内核权限模型下 caller 只能 set 自己 owner 的 agent，跨 owner 会 403。
    // 保留脏 binding 也无害：injection / memory-bridge / 面板详情页在读侧调
    // apply_visibility_filter=true 过滤掉 canBindAsset=false 的项。
    return respondEnvelope(c, envelope);
  });
}

// ── team-member/add 成功后：为 default-agent 导入预置 Skill ──

async function importDefaultSkillsForNewMember(
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<void> {
  try {
    const userId = body.user_id as string | undefined;
    const teamId = body.team_id as string | undefined;
    if (!userId || !teamId) return;

    // 1. 获取用户信息（拿 username 拼 agent 名称）
    const userEnv = await deps.metaKernel.invoke('user/get', { user_id: userId }, ctx);
    if (userEnv.code !== 0) return;
    const user = userEnv.data as { username?: string };
    const agentName = `default-agent-${user.username ?? userId}`;

    // 2. 查 default-agent
    const agentsEnv = await deps.metaKernel.invoke('agent/list', {
      team_id: teamId,
      owner_user_id: userId,
      limit: 50,
      offset: 0,
    }, ctx);
    if (agentsEnv.code !== 0) return;
    const agents = (agentsEnv.data as { items?: Array<{ agent_id: string; name: string }> })?.items ?? [];
    const defaultAgent = agents.find(a => a.name === agentName);
    if (!defaultAgent) {
      deps.logger.warn('default agent not found, skip skill import', {
        instanceId: ctx.instanceId, userId, teamId, agentName,
      });
      return;
    }

    // 3. 创建预置 Skill（依赖内核 name 唯一约束做幂等，42201 直接跳过）
    for (const skill of DEFAULT_SKILLS) {
      try {
        const createEnv = await deps.skillKernel.invoke('create', {
          user_id: userId,
          team_id: teamId,
          agent_id: defaultAgent.agent_id,
          name: skill.name,
          content: skill.content,
        }, ctx);
        if (createEnv.code === 0) {
          deps.logger.info(`default skill "${skill.name}" created`, {
            instanceId: ctx.instanceId,
            agentId: defaultAgent.agent_id,
          });
        } else if (createEnv.code !== 42201) {
          // 42201 = SKILL_NAME_DUPLICATE，忽略
          deps.logger.warn(`default skill "${skill.name}" create failed`, {
            instanceId: ctx.instanceId,
            code: createEnv.code,
            message: createEnv.message,
          });
        }
      } catch (err) {
        deps.logger.warn(`default skill "${skill.name}" create error`, {
          instanceId: ctx.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    deps.logger.warn('import default skills for new member failed', {
      instanceId: ctx.instanceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
