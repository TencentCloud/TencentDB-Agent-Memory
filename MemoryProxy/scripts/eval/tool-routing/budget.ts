/** Conservative peak-price accounting for the explicitly scoped DeepSeek V4 Flash experiment. */
export const PEAK_USD_PER_MILLION = { input: 0.44, output: 1.32, cache: 0.014 } as const;
export interface BudgetState { accountedUsd: number; pendingUsd: number }
export class EvaluationBudget {
  private state: BudgetState;
  get accountedUsd() { return this.state.accountedUsd; }
  get pendingUsd() { return this.state.pendingUsd; }
  constructor(readonly limitUsd: number, private readonly persistence?: {
    initial: BudgetState;
    save: (state: BudgetState) => void;
  }) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error("Budget must be positive USD");
    this.state = { ...(persistence?.initial ?? { accountedUsd: 0, pendingUsd: 0 }) };
    if ([this.state.accountedUsd, this.state.pendingUsd].some((amount) => !Number.isFinite(amount) || amount < 0)) {
      throw new Error("Evaluation cost budget ledger has invalid balances");
    }
  }
  private save(state: BudgetState) {
    // Persist before a caller can issue another provider request. A failed save throws closed.
    this.persistence?.save(state);
    this.state = state;
  }
  reserve(inputBytes: number, maxOutputTokens: number) {
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0
      || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error("Evaluation cost budget requires valid request bounds");
    // UTF-8 byte length plus framing allowance is deliberately much larger
    // than observed prompt tokens. Unknown usage retains this reservation.
    const reserve = ((inputBytes + 1024) * PEAK_USD_PER_MILLION.input
      + maxOutputTokens * PEAK_USD_PER_MILLION.output) / 1e6;
    if (this.accountedUsd + this.pendingUsd + reserve > this.limitUsd) throw new Error("Evaluation cost budget exhausted before request");
    this.save({ accountedUsd: this.accountedUsd, pendingUsd: this.pendingUsd + reserve });
    let settled = false;
    return (usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number }) => {
      if (settled) return;
      let charge = reserve;
      if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)
        || usage.prompt_tokens! < 0 || usage.completion_tokens! < 0) {
        // Unknown usage retains the entire reservation, including failed transport attempts.
      } else {
        const hit = Number.isSafeInteger(usage.prompt_cache_hit_tokens) && usage.prompt_cache_hit_tokens! >= 0
          && usage.prompt_cache_hit_tokens! <= usage.prompt_tokens! ? usage.prompt_cache_hit_tokens! : 0;
        charge = ((usage.prompt_tokens! - hit) * PEAK_USD_PER_MILLION.input
          + hit * PEAK_USD_PER_MILLION.cache + usage.completion_tokens! * PEAK_USD_PER_MILLION.output) / 1e6;
      }
      const pending = this.pendingUsd - reserve;
      this.save({ accountedUsd: this.accountedUsd + charge, pendingUsd: pending < 1e-12 ? 0 : pending });
      settled = true;
    };
  }
}
