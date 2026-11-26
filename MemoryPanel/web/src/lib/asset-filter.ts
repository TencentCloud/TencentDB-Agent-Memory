/**
 * asset-filter —— Skill / Wiki / CodeGraph 资产列表的本地关键词过滤（纯函数）。
 *
 * 只对已加载到前端的列表做内存过滤，不发起任何请求；规则统一：
 *   - 关键词 trim + 大小写不敏感；空关键词视为"不过滤"，返回全部；
 *   - 任一可搜索字段包含关键词即命中（子串匹配）；
 *   - null / undefined 字段自动跳过。
 *
 * 各资产类型可搜索的字段由下方 `*SearchFields` 声明，三处页面共用，
 * 避免每个页面各写一套 includes 拼接。本模块不依赖 React / DOM，可在 node 环境单测。
 */

export type SearchableField = string | null | undefined;

/** 规范化关键词：trim + 小写；空白关键词返回空串（=不过滤）。 */
export function normalizeKeyword(keyword: string | null | undefined): string {
  return (keyword ?? '').trim().toLowerCase();
}

/** 关键词是否处于生效状态（非空白）。 */
export function isKeywordActive(keyword: string | null | undefined): boolean {
  return normalizeKeyword(keyword) !== '';
}

/** 字段列表中任一字段包含关键词即命中；空关键词恒命中。 */
export function matchesKeyword(
  fields: readonly SearchableField[],
  keyword: string | null | undefined,
): boolean {
  const needle = normalizeKeyword(keyword);
  if (!needle) return true;
  return fields.some((field) => !!field && field.toLowerCase().includes(needle));
}

/** 按关键词过滤列表；空关键词返回原数组（引用不变，便于 memo）。 */
export function filterByKeyword<T>(
  items: readonly T[],
  keyword: string | null | undefined,
  getFields: (item: T) => readonly SearchableField[],
): T[] {
  if (!isKeywordActive(keyword)) return items as T[];
  return items.filter((item) => matchesKeyword(getFields(item), keyword));
}

/* ── 各资产类型的可搜索字段（只取列表上可见/可识别的字段） ── */

export interface SkillSearchable {
  skill_id: string;
  name: string;
  description?: string | null;
}

export function skillSearchFields(skill: SkillSearchable): SearchableField[] {
  return [skill.name, skill.description, skill.skill_id];
}

export interface WikiSearchable {
  wiki_id: string;
  name: string;
  summary?: string | null;
  source_url?: string | null;
  owner_user_id?: string | null;
}

export function wikiSearchFields(wiki: WikiSearchable): SearchableField[] {
  // summary 即 wiki 的描述；owner_user_id 保留原有按归属人搜索的能力。
  return [wiki.name, wiki.summary, wiki.wiki_id, wiki.source_url, wiki.owner_user_id];
}

export interface CodeGraphSearchable {
  code_graph_id: string;
  repo_name: string;
  repo_url: string;
  branch?: string | null;
  commit_hash?: string | null;
  owner_user_id?: string | null;
}

/**
 * @param displayName 列表上实际展示的仓库名（formatRepoName 结果），
 *   与 repo_name 不一致时也能按所见文字搜索。
 */
export function codeGraphSearchFields(
  source: CodeGraphSearchable,
  displayName?: string,
): SearchableField[] {
  return [
    displayName,
    source.repo_name,
    source.repo_url,
    source.code_graph_id,
    source.branch,
    source.commit_hash,
    source.owner_user_id,
  ];
}

/* ── 空态 / 计数 ── */

/**
 * 列表空态判定：
 *   - 'empty'   范围内本来就没有资产（显示原有"暂无资产"文案）；
 *   - 'noMatch' 有资产但被搜索/筛选全部过滤掉（显示专用"无匹配"文案）；
 *   - null      有可展示的条目。
 */
export type FilterEmptyState = 'empty' | 'noMatch' | null;

export function resolveFilterEmptyState(total: number, matched: number): FilterEmptyState {
  if (total === 0) return 'empty';
  if (matched === 0) return 'noMatch';
  return null;
}
