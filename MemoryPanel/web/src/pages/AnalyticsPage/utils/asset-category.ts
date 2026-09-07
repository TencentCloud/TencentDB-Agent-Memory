/**
 * 端点 / bridge_source → 四类资产（Memory / Skill / Wiki / Code Graph）归类。
 *
 * 为什么在面板侧做：CH 的 `tool_call_logs` 只记录 `executed_endpoint` 与
 * `bridge_source`，内核 `tool-calls/endpoint-share` 按原始端点聚合（17 个平铺项），
 * 缺少业务语义。本期不改 Core，故归类规则放在面板侧——与旧面板
 * （online-data-platform `trace-context.ts:normalizeCategory`）同样是纯字符串
 * 匹配，不涉及 LLM。
 *
 * 判定优先级：
 *   1. bridge_source（最权威）：memory-bridge / skill-bridge / knowledge-service
 *   2. 端点前缀 / 端点名（endpoint-share 只有端点名时的唯一依据）
 *   3. 兜底 other —— 新端点上线时不会被错误归类，而是显式暴露为「其他」
 *
 * 新增端点后若落入 other，应在此补充规则，而不是让它静默混入某一类。
 */

export type AssetCategory = 'memory' | 'skill' | 'wiki' | 'codegraph' | 'other';

export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'memory',
  'skill',
  'wiki',
  'codegraph',
  'other',
] as const;

/** knowledge-service 内部按端点再分 Wiki / Code Graph。 */
const CODEGRAPH_TOOLS = ['node', 'impact', 'files', 'refs', 'callers', 'callees', 'graph'];
const WIKI_TOOLS = ['search', 'explore', 'read_page', 'list_pages', 'get_info', 'page'];

/** memory 侧端点（含 scenario / atomic / conversation 三组）。 */
const MEMORY_PREFIXES = ['atomic/', 'scenario/', 'conversation/', 'persona', 'chat-memory'];

/** skill 侧端点。 */
const SKILL_EXACT = ['get', 'get-by-name', 'search', 'list', 'listing', 'extract', 'versions', 'fork'];
const SKILL_PREFIXES = ['files/', 'skill/'];

function classifyKnowledgeTool(endpoint: string): AssetCategory {
  // 形如 tools/call/<tool>；取最后一段判定
  const tool = endpoint.split('/').pop() ?? '';
  if (CODEGRAPH_TOOLS.some((t) => tool.includes(t))) return 'codegraph';
  if (WIKI_TOOLS.some((t) => tool.includes(t))) return 'wiki';
  return 'wiki';
}

/**
 * 归类单条调用。
 *
 * @param endpoint executed_endpoint（必填，endpoint-share 场景下唯一依据）
 * @param bridgeSource bridge_source（可选，tool-calls/list 场景下可用，优先级最高）
 */
export function classifyAsset(endpoint: string, bridgeSource?: string): AssetCategory {
  const src = (bridgeSource ?? '').toLowerCase();
  const ep = (endpoint ?? '').toLowerCase();

  // 1. bridge_source 优先
  if (src.startsWith('memory')) return 'memory';
  if (src.startsWith('skill')) return 'skill';
  if (src.startsWith('knowledge')) return classifyKnowledgeTool(ep);

  if (!ep) return 'other';

  // 2. 端点判定
  if (ep.startsWith('tools/call/')) return classifyKnowledgeTool(ep);
  if (MEMORY_PREFIXES.some((p) => ep.startsWith(p))) return 'memory';
  if (SKILL_PREFIXES.some((p) => ep.startsWith(p))) return 'skill';
  if (SKILL_EXACT.includes(ep)) return 'skill';

  // 3. 兜底：不猜
  return 'other';
}

export interface CategoryStat {
  category: AssetCategory;
  calls: number;
  pct: number;
  /** 归入该类的原始端点（按调用数降序），供 tooltip 展示归类依据。 */
  endpoints: Array<{ endpoint: string; calls: number }>;
}

/**
 * 把 endpoint-share 的全量聚合结果归并为四类。
 *
 * 输入来自内核 SQL 的全量聚合，故输出的 calls/pct 同样是**全量准确值**，
 * 不是抽样（与成员维度不同）。pct 按传入行的总调用数重新计算，避免
 * 直接相加原始 pct 带来的舍入偏差。
 */
export function aggregateByCategory(
  rows: Array<{ executed_endpoint: string; calls: number }>,
): CategoryStat[] {
  const buckets = new Map<AssetCategory, { calls: number; endpoints: Array<{ endpoint: string; calls: number }> }>();
  let total = 0;

  for (const row of rows) {
    const category = classifyAsset(row.executed_endpoint);
    const calls = Number(row.calls) || 0;
    total += calls;
    const bucket = buckets.get(category) ?? { calls: 0, endpoints: [] };
    bucket.calls += calls;
    bucket.endpoints.push({ endpoint: row.executed_endpoint, calls });
    buckets.set(category, bucket);
  }

  return ASSET_CATEGORIES.map((category) => {
    const bucket = buckets.get(category);
    return {
      category,
      calls: bucket?.calls ?? 0,
      pct: total > 0 ? Math.round(((bucket?.calls ?? 0) / total) * 10000) / 100 : 0,
      endpoints: (bucket?.endpoints ?? []).sort((a, b) => b.calls - a.calls),
    };
  })
    // 全为 0 的 other 不展示，避免干扰；四类主资产始终展示（0 也有意义）
    .filter((s) => s.category !== 'other' || s.calls > 0);
}
