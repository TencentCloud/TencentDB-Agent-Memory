/**
 * 内核 /v3/skill/* 数据面 action 列表（14 条，全部 POST）。
 *
 * 对接文档：tdai-memory-openclaw-plugin/docs/skill-api-for-frontend.md
 *
 * 与 /v3/meta/* 不同点：
 *   - skill 数据面自带独立存储（skill_id 前缀 skl-），团队内可读、owner agent 可写；
 *   - 身份字段（user_id / team_id / agent_id / task_id）放在 body，不放 Header；
 *   - 分页用嵌套 pagination.{limit,offset}，不是顶层 limit/offset，故不需要 meta 的
 *     sanitizeBody 逻辑，body 原样透传即可。
 */

/** 读操作（可选 agent_id）；此处仅用于文档标注，透传不区分。 */
export const SKILL_LIST_ACTIONS = new Set(['list', 'search', 'versions']);

export const SKILL_ACTIONS = [
  'create',
  'update',
  'patch',
  'delete',
  'get',
  'list',
  'search',
  'versions',
  'files/write',
  'files/remove',
  'files/read',
  'listing',
  'extract',
  'export',
] as const;

export type SkillAction = (typeof SKILL_ACTIONS)[number];

export const ALLOWED_SKILL_ACTIONS = new Set<string>(SKILL_ACTIONS);

export function isAllowedSkillAction(action: string): action is SkillAction {
  return ALLOWED_SKILL_ACTIONS.has(action);
}
