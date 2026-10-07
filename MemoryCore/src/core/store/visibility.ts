/**
 * L1 审核可见性；契约与剩余门禁见 docs/change-ledger.md。
 * 消费读默认抑制，审计/去重显式指定范围；开关只控制 HTTP 审核写入口。
 */
export type ReviewStatus = "active" | "quarantined";
export type VisibilityScope = "active" | "quarantined" | "all";

const DEFAULT_VISIBILITY_SCOPE: VisibilityScope = "active";
export const DEFAULT_REVIEW_STATUS: ReviewStatus = "active";
const VISIBILITY_OVERFETCH_FACTOR = 3;
const VISIBILITY_OVERFETCH_CAP = 500;

let overrideEnabled: boolean | undefined;

export function isMemoryReviewEnabled(): boolean {
  if (overrideEnabled !== undefined) return overrideEnabled;
  const v = process.env.TDAI_MEMORY_REVIEW_ENABLED;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** 仅供测试：传 undefined 恢复环境变量。 */
export function __setMemoryReviewEnabledForTests(v: boolean | undefined): void {
  overrideEnabled = v;
}

export interface VisibilityAware {
  /** 普通 HTTP 消费接口不得透传此字段；只有审核接口允许显式口径。 */
  visibility?: VisibilityScope;
}

export function resolveVisibilityScope(filter: VisibilityAware | undefined): VisibilityScope {
  return filter?.visibility ?? DEFAULT_VISIBILITY_SCOPE;
}

export function visibilityNeedsFilter(scope: VisibilityScope): boolean {
  return scope !== "all";
}

export function rowMatchesVisibility(
  row: { review_status?: string | null },
  scope: VisibilityScope,
): boolean {
  return scope === "all" || normalizeReviewStatus(row.review_status) === scope;
}

/** 老数据缺字段按 active；未知非空值按 quarantined，审计读另报异常。 */
export function normalizeReviewStatus(v: unknown): ReviewStatus {
  return v === undefined || v === null || v === "" || v === "active" ? DEFAULT_REVIEW_STATUS : "quarantined";
}

/** 补偿封顶但不得缩减调用方原有预算；all 保留基线行为。 */
export function withVisibilityOverFetch(baseRetrieveCount: number, scope: VisibilityScope): number {
  if (!visibilityNeedsFilter(scope)) return baseRetrieveCount;
  return Math.max(baseRetrieveCount, Math.min(baseRetrieveCount * VISIBILITY_OVERFETCH_FACTOR, VISIBILITY_OVERFETCH_CAP));
}

export function recallTruncated(params: {
  requested: number;
  retrieved: number;
  retrieveLimit: number;
  kept: number;
  scope: VisibilityScope;
}): boolean {
  return visibilityNeedsFilter(params.scope) && params.kept < params.requested && params.retrieved >= params.retrieveLimit;
}

export function recallTruncationWarning(where: string, p: { requested: number; kept: number; retrieveLimit: number }): string {
  return (
    `[memory-review] recall_truncated at ${where}: requested=${p.requested} kept=${p.kept} ` +
    `retrieveLimit=${p.retrieveLimit} — 被撤回记忆占满了超取窗口，召回结果可能不完整`
  );
}
