/**
 * 内核 /v3/meta/* 公开 action 列表（v3.2：55 条，不含 internal）。
 * 注：agent-fixed-asset/* 仍在 META_ACTIONS 登记但公开 proxy 501 NOT_IN_SCOPE；
 * Control 业务路由可通过 metaKernel.invoke 直调。
 */

export const META_LIST_ACTIONS = new Set([
  'user/list',
  'user-key/list',
  'team/list',
  'team-member/list',
  'agent/list',
  'task/list',
  'task-agent/list',
  'asset/list',
  'asset/list-accessible',
  'agent-fixed-asset/list',
  'agent-fixed-asset/list-with-detail',
  // summary-by-agents 非分页 list 信封，不进 META_LIST_ACTIONS
  'acl/list',
  'participation-log/list',
]);

export const META_ACTIONS = [
  'user/create',
  // 姊妹接口：admin 建号时显式指定 user_key，其他行为与 user/create 完全对称。
  'user/create-with-key',
  'user/get',
  'user/delete',
  'user/list',
  'user-key/create',
  'user-key/list',
  'user-key/get',
  'user-key/revoke',
  'user-key/update',
  'team/create',
  'team/get',
  'team/update',
  'team/delete',
  'team/list',
  'team-member/add',
  'team-member/remove',
  'team-member/list',
  'team-member/get',
  'agent/create',
  'agent/get',
  'agent/update',
  'agent/delete',
  'agent/list',
  'agent/archive',
  'agent/set-default-template',
  'agent/get-default-template',
  'task/create',
  'task/get',
  'task/update',
  'task/delete',
  'task/list',
  'task/archive',
  'task-agent/link',
  'task-agent/unlink',
  'task-agent/list',
  'participation-log/append',
  'participation-log/list',
  'asset/create',
  'asset/get',
  'asset/update',
  'asset/delete',
  'asset/list',
  'asset/list-accessible',
  'asset/touch-usage',
  'agent-fixed-asset/set',
  'agent-fixed-asset/list',
  'agent-fixed-asset/list-with-detail',
  'agent-fixed-asset/summary-by-agents',
  'acl/grant',
  'acl/revoke',
  'acl/list',
  'acl/check',
  'auth/verify',
  'instance-quota/get',
  'config/user/get',
  'config/user/set',
] as const;

export type MetaAction = (typeof META_ACTIONS)[number];

/**
 * 暂未开放给面板的 action 前缀。
 *
 * asset/* 已放开：skill「分配到 Agent」走授权接口（acl/grant）时，需先把 skill
 * 登记为 meta 资产（asset/create，owner=当前登录用户），再授予目标 agent use 权限。
 * agent-fixed-asset/*（运行时固定注入绑定）仍暂不开放。
 */
const NOT_IN_SCOPE_PREFIXES = ['agent-fixed-asset/'] as const;

export function isNotInScopeAction(action: string): boolean {
  return NOT_IN_SCOPE_PREFIXES.some((prefix) => action.startsWith(prefix));
}

export const ALLOWED_PANEL_ACTIONS = new Set(
  META_ACTIONS.filter((action) => !isNotInScopeAction(action)),
);
