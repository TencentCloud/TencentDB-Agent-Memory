/** Exact binomial inversion and conservative paired bounds. No normal or bootstrap approximation. */
function validateCounts(events: number, trials: number, alpha: number): void {
  if (!Number.isSafeInteger(trials) || trials < 1 || !Number.isSafeInteger(events)
    || events < 0 || events > trials) throw new RangeError("Expected 0 <= events <= trials with integer trials >= 1");
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new RangeError("alpha must be between 0 and 1");
}

function logAdd(a: number, b: number): number {
  const largest = Math.max(a, b);
  return largest === -Infinity ? largest : largest + Math.log1p(Math.exp(Math.min(a, b) - largest));
}

/** Log P[X <= events], summed in log space to avoid underflow for large samples. */
function logBinomialCdf(events: number, trials: number, probability: number): number {
  if (probability === 0 || events === trials) return 0;
  if (probability === 1) return -Infinity;
  const logOdds = Math.log(probability) - Math.log1p(-probability);
  let term = trials * Math.log1p(-probability);
  let sum = term;
  for (let k = 1; k <= events; k++) {
    term += Math.log(trials - k + 1) - Math.log(k) + logOdds;
    sum = logAdd(sum, term);
  }
  return Math.min(sum, 0);
}

/** One-sided (1-alpha) Clopper-Pearson upper confidence bound. */
export function exactBinomialUpper(events: number, trials: number, alpha = 0.05): number {
  validateCounts(events, trials, alpha);
  if (events === trials) return 1;
  if (events === 0) return -Math.expm1(Math.log(alpha) / trials);
  let low = events / trials;
  let high = 1;
  const target = Math.log(alpha);
  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = (low + high) / 2;
    if (logBinomialCdf(events, trials, middle) > target) low = middle;
    else high = middle;
  }
  return high;
}

/** One-sided (1-alpha) Clopper-Pearson lower confidence bound. */
export function exactBinomialLower(events: number, trials: number, alpha = 0.05): number {
  validateCounts(events, trials, alpha);
  return events === 0 ? 0 : 1 - exactBinomialUpper(trials - events, trials, alpha);
}

export interface BinaryPair { baseline: boolean; candidate: boolean }

/**
 * Delta = P(candidate=1) - P(baseline=1) = P(gain) - P(loss).
 * Since P(gain) >= 0 and P(loss) >= 0, -U(loss) <= Delta <= U(gain).
 * Each bound separately has at least 1-alpha coverage for independent identically
 * distributed pairs. These are NOT a simultaneous 1-alpha two-sided interval.
 * This deliberately ignores gains when proving noninferiority. It is conservative,
 * including when no discordant pairs were observed, and needs its own power plan.
 */
export function conservativePairedBounds(pairs: readonly BinaryPair[], alpha = 0.05) {
  const gains = pairs.filter((pair) => !pair.baseline && pair.candidate).length;
  const losses = pairs.filter((pair) => pair.baseline && !pair.candidate).length;
  const n = pairs.length;
  validateCounts(gains, n, alpha);
  return {
    method: "exact-discordant-event-bounds" as const,
    n,
    gains,
    losses,
    discordance: (gains + losses) / n,
    baseline_rate: pairs.filter((pair) => pair.baseline).length / n,
    candidate_rate: pairs.filter((pair) => pair.candidate).length / n,
    difference: (gains - losses) / n,
    lower: -exactBinomialUpper(losses, n, alpha),
    upper: exactBinomialUpper(gains, n, alpha),
    confidence_level_each_one_sided: 1 - alpha,
    simultaneous_two_sided: false as const,
  };
}
