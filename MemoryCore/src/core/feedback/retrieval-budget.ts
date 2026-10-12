/** Optional, read-only L0 budget policy. Never writes memory or interprets consent. */
export interface BudgetHit { id: string; content: string; score: number }
export interface BudgetPolicy { schemaVersion: 1; threshold: number; approved: boolean }
export const BUDGET_LIMITS = Object.freeze({ baselineK: 5, expandedK: 12,
  maxHitBytes: 8192, maxInjectionBytes: 65536, timeoutMs: 100, maxPending: 4 });
let pending = 0;
export const BUDGET_THRESHOLDS = Object.freeze([0, 0.01, 0.05, 0.15, 1]);
export type BudgetMode = 'baseline' | 'candidate' | 'adaptive';
export interface BudgetDecision<T extends BudgetHit> {
  hits: readonly T[]; mode: BudgetMode; k: number; auxiliaryCalls: number;
  fallback: boolean; reason: string | null; signalType: string;
  gap: number | null; elapsedMs: number;
}

function checked(hits: readonly BudgetHit[], limit: number): void {
  if (!Array.isArray(hits) || hits.length > limit) throw new Error('capacity');
  const seen = new Set<string>(); let bytes = 0;
  for (const hit of hits) {
    if (!hit || typeof hit.id !== 'string' || !hit.id || seen.has(hit.id) ||
        typeof hit.content !== 'string' || !Number.isFinite(hit.score) ||
        hit.score < 0 || hit.score > 1) throw new Error('invalid_hits');
    seen.add(hit.id);
    const size = Buffer.byteLength(hit.content, 'utf8'); bytes += size;
    if (size > BUDGET_LIMITS.maxHitBytes || bytes > BUDGET_LIMITS.maxInjectionBytes)
      throw new Error('capacity');
  }
}
export function validateBudgetPolicy(value: unknown): asserts value is BudgetPolicy {
  if (!value || typeof value !== 'object') throw new Error('invalid_policy');
  const p = value as BudgetPolicy;
  if (Object.keys(p).sort().join(',') !== 'approved,schemaVersion,threshold' ||
      p.schemaVersion !== 1 || typeof p.approved !== 'boolean' ||
      !BUDGET_THRESHOLDS.includes(p.threshold)) throw new Error('invalid_policy');
}
export function selectBudget<T extends BudgetHit>(base: readonly T[], expanded: readonly T[],
  policy: BudgetPolicy): { hits: readonly T[]; gap: number | null } {
  validateBudgetPolicy(policy); checked(base, 5); checked(expanded, 12);
  if (expanded.length < base.length || base.some((hit, i) =>
    hit.id !== expanded[i]?.id || hit.content !== expanded[i]?.content ||
    hit.score !== expanded[i]?.score)) throw new Error('prefix_mismatch');
  if (expanded.length < 6) return { hits: base, gap: null };
  for (let i = 1; i < expanded.length; i++)
    if (expanded[i]!.score > expanded[i-1]!.score) throw new Error('invalid_order');
  const gap = (expanded[4]!.score - expanded[5]!.score) / Math.max(expanded[0]!.score, 1e-12);
  return { hits: gap <= policy.threshold ? expanded : base, gap };
}

/** Baseline is acquired once and retained verbatim on every optional-path failure.
 * A throwing baseline is a host error, not a successful fallback. Late auxiliary
 * results are ignored. The callback must honor abort; synchronous work cannot
 * be preempted by this timer. No query/content is emitted in decision telemetry.
 */
export async function retrieveWithBudget<T extends BudgetHit>(options: {
  baseline: () => readonly T[] | Promise<readonly T[]>;
  expanded: (limit: number, signal: AbortSignal) => readonly T[] | Promise<readonly T[]>;
  mode?: BudgetMode; policy?: unknown;
}): Promise<BudgetDecision<T>> {
  const start = performance.now();
  const base = await options.baseline();
  const mode = options.mode ?? 'baseline';
  let auxiliaryCalls = 0;
  const result = (hits: readonly T[], reason: string | null, gap: number | null = null): BudgetDecision<T> => ({
    hits, mode, k: hits === base ? 5 : 12, auxiliaryCalls,
    fallback: reason !== null, reason, signalType: gap === null ? 'none' : 'retrieval_boundary_gap',
    gap, elapsedMs: performance.now() - start,
  });
  if (mode === 'baseline') return result(base, null);
  if (mode !== 'candidate' && mode !== 'adaptive') return result(base, 'invalid_mode');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    validateBudgetPolicy(options.policy);
    if (mode === 'adaptive' && !options.policy.approved) return result(base, 'not_adopted');
    checked(base, 5);
    if (pending >= BUDGET_LIMITS.maxPending) return result(base, 'auxiliary_busy');
    auxiliaryCalls = 1;
    pending++;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('auxiliary_timeout')); }, BUDGET_LIMITS.timeoutMs);
    });
    const operation = Promise.resolve().then(() => options.expanded(12, controller.signal))
      .finally(() => { pending--; });
    const expanded = await Promise.race([operation, timeout]);
    const selected = selectBudget(base, expanded, options.policy);
    return result(selected.hits, null, selected.gap);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const allowed = ['invalid_policy', 'invalid_hits', 'invalid_order', 'capacity', 'prefix_mismatch', 'auxiliary_timeout'];
    return result(base, allowed.includes(code) ? code : 'auxiliary_error');
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
