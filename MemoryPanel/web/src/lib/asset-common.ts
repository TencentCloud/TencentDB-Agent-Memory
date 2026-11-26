/**
 * asset-common —— 资产（Wiki / Code / Skill / Memory）页共享的类型与纯工具函数。
 *
 * 此前这些类型与工具函数在 wiki-constants.ts / code-constants.ts /
 * memory types.ts 中各自重复定义，这里统一收口，页面文件通过 re-export 保持
 * 原有 import 路径不变。
 */

/** 列表视图切换：卡片 / 表格 */
export type ViewMode = 'card' | 'list';

/** 列表状态筛选 */
export type StatusFilter = 'all' | 'ready' | 'processing' | 'error';

/** 资产页子视图：列表 / 详情 */
export type SubView = 'list' | 'detail';

/** 资产作用域：团队池 / 固定资产 */
export type ScopeTab = 'team' | 'fixed';

/**
 * ISO 时间字符串 → 面板展示格式（本地时区，'MM/DD HH:MM'）。
 * 输入为空或非法 → 返回 '—'。
 * 此前在 wiki-constants.ts 与 code-constants.ts 中实现完全相同，收敛到此。
 */
export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ===== 列表关键词过滤 ===== */

/**
 * 参与关键词匹配的字段。
 * 全部可选且允许 null —— 列表数据来自不同接口（数据面 / asset 派生），
 * 缺字段是常态，不能让过滤逻辑因此抛错。
 */
export interface SkillKeywordFields {
  name?: string | null;
  skill_id?: string | null;
  description?: string | null;
  owner_user_id?: string | null;
}

/**
 * 关键词归一化：去首尾空白 + 转小写。
 * null / undefined / 纯空白 → ''（调用方据此判定"未搜索"）。
 */
export function normalizeKeyword(keyword?: string | null): string {
  return typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
}

/** 字段取值归一化：非字符串（null / undefined / 异常值）一律视作空串。 */
function normalizeField(value?: string | null): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * 单条记录是否命中关键词（多字段 OR、子串、大小写不敏感）。
 * 关键词为空 / 纯空白时恒为 true —— 「没有关键词」等价于「不过滤」。
 */
export function matchesSkillKeyword(skill: SkillKeywordFields, keyword?: string | null): boolean {
  const needle = normalizeKeyword(keyword);
  if (!needle) return true;
  return (
    normalizeField(skill.name).includes(needle) ||
    normalizeField(skill.skill_id).includes(needle) ||
    normalizeField(skill.description).includes(needle) ||
    normalizeField(skill.owner_user_id).includes(needle)
  );
}

/**
 * 批量过滤，保留原顺序、不修改入参。
 *
 * 关键词为空时**返回入参本身**（同一引用），这样 hook 里的 useMemo
 * 在"未搜索"状态下不会因为每次返回新数组而让下游重新渲染。
 */
export function filterSkillsByKeyword<T extends SkillKeywordFields>(
  skills: T[],
  keyword?: string | null,
): T[] {
  if (!normalizeKeyword(keyword)) return skills;
  return skills.filter((skill) => matchesSkillKeyword(skill, keyword));
}
