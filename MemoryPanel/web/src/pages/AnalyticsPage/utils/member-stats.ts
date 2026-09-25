/**
 * 成员维度聚合 —— 面板侧按 user_id 归并调用明细。
 *
 * 为什么在面板侧做：内核未提供「按成员聚合」的展示接口
 * （`tool-calls/watermark` 虽然 GROUP BY user_id，但它的返回是给 recall 增量链路
 * 用的指纹结构，且不含端点/耗时，不适合展示），本期不改 Core。
 *
 * ⚠️ **抽样口径**：数据来自 `tool-calls/list` 分页拉取，单页上限 200、最多
 * MAX_SAMPLE_PAGES 页。当 total 超出采样量时 truncated=true，UI 必须显式标注
 * 「基于最近 N / total 条」，不得当作全量口径。
 */
import { classifyAsset, type AssetCategory } from './asset-category';
import type { ToolCallRow } from '@/lib/api/analytics';

/** 最多采样页数（200/页 → 上限 2000 条）。 */
export const MAX_SAMPLE_PAGES = 10;

export interface MemberStat {
  user_id: string;
  /** 采样窗口内的调用数。 */
  calls: number;
  /** 去重 session 数。 */
  sessions: number;
  /** 该成员调用最多的资产类别。 */
  topCategory: AssetCategory | null;
  /** 各类别调用数。 */
  byCategory: Record<AssetCategory, number>;
  /** 平均耗时（ms）。 */
  avgElapsedMs: number;
  /** 失败数（upstream_status >= 400 或 reject_reason 非空）。 */
  errors: number;
  /** 采样窗口内最近一次调用时间。 */
  lastCallAt: string;
}

function emptyByCategory(): Record<AssetCategory, number> {
  return { memory: 0, skill: 0, wiki: 0, codegraph: 0, other: 0 };
}

/**
 * 空 user_id 的聚合桶标签。
 *
 * ⚠️ 这**不是**真实 user_id，只是面板侧的占位分组：
 *   - 不可用于 user/list 名称解析（会白占一个 user_ids 配额且查不到）
 *   - 不可用于下钻（把它当 user_id 传给内核语义错误）
 * 调用方需显式识别并跳过，展示上用 i18n 的「未归属」。
 */
export const UNASSIGNED_USER = '(unassigned)';

/**
 * 把调用明细按 user_id 聚合，按调用数降序返回。
 *
 * user_id 为空的行归入 `UNASSIGNED_USER` 桶：这类事件在 CH 中确实存在
 * （上报侧未带 user 上下文），静默丢弃会让合计数与 KPI 对不上。
 */
export function aggregateByMember(rows: ToolCallRow[]): MemberStat[] {
  const map = new Map<
    string,
    MemberStat & { sessionSet: Set<string>; elapsedSum: number; elapsedCount: number }
  >();

  for (const row of rows) {
    const key = row.user_id || UNASSIGNED_USER;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        user_id: key,
        calls: 0,
        sessions: 0,
        topCategory: null,
        byCategory: emptyByCategory(),
        avgElapsedMs: 0,
        errors: 0,
        lastCallAt: '',
        sessionSet: new Set<string>(),
        elapsedSum: 0,
        elapsedCount: 0,
      };
      map.set(key, entry);
    }

    entry.calls += 1;
    if (row.session_key) entry.sessionSet.add(row.session_key);

    const category = classifyAsset(row.executed_endpoint, row.bridge_source);
    entry.byCategory[category] += 1;

    // elapsed_ms 为 0 多为未记录，不计入均值分母，避免把平均耗时稀释成 0
    if (row.elapsed_ms > 0) {
      entry.elapsedSum += row.elapsed_ms;
      entry.elapsedCount += 1;
    }

    if (row.upstream_status >= 400 || row.reject_reason) entry.errors += 1;
    if (row.timestamp > entry.lastCallAt) entry.lastCallAt = row.timestamp;
  }

  return Array.from(map.values())
    .map((e) => {
      const entries = Object.entries(e.byCategory) as Array<[AssetCategory, number]>;
      const top = entries.reduce<[AssetCategory, number] | null>(
        (acc, cur) => (cur[1] > 0 && (!acc || cur[1] > acc[1]) ? cur : acc),
        null,
      );
      return {
        user_id: e.user_id,
        calls: e.calls,
        sessions: e.sessionSet.size,
        topCategory: top ? top[0] : null,
        byCategory: e.byCategory,
        avgElapsedMs: e.elapsedCount > 0 ? Math.round(e.elapsedSum / e.elapsedCount) : 0,
        errors: e.errors,
        lastCallAt: e.lastCallAt,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.user_id.localeCompare(b.user_id));
}
