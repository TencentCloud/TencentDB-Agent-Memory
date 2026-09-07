/**
 * Adaptive context window calculator.
 *
 * Computes the optimal number of recent conversation turns to keep in the
 * dynamic (post-CACHE_BOUNDARY) region so the stable prefix stays within
 * the provider's prompt-cache budget.
 *
 * N_optimal = floor((L - S - M) / (2 * T))
 *
 *   L = context window size (tokens)
 *   S = stable area size (persona + scene + tools guide + summaries + system prompt)
 *   M = prompt tail size (L1 memories, estimated)
 *   T = average tokens per turn (user + assistant)
 *
 * Clamped to [MIN_RECENT_TURNS, MAX_RECENT_TURNS] (3–15).
 */

/** Default context window for DeepSeek V3 (tokens). */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Minimum recent turns (avoid overly aggressive truncation). */
export const MIN_RECENT_TURNS = 3;

/** Maximum recent turns (avoid tail latency from over-long prompt). */
export const MAX_RECENT_TURNS = 15;

/** Default recent turns when adaptive window is disabled. */
export const DEFAULT_RECENT_TURNS = 8;

/** Rough chars-to-tokens ratio for mixed Chinese/English text. */
const CHARS_PER_TOKEN = 3;

export interface AdaptiveWindowParams {
  /** Total context window in tokens (default 128K for DeepSeek V3). */
  contextWindowTokens?: number;
  /** Stable area character count (persona + scene + tools + summaries + system prompt). */
  stableAreaChars: number;
  /** Estimated prompt tail character count (L1 memories). */
  tailChars: number;
  /** Average tokens per turn (user + assistant). If omitted, uses a rolling estimate. */
  avgTokensPerTurn?: number;
  /** Whether adaptive window is enabled. If false, returns DEFAULT_RECENT_TURNS. */
  adaptive?: boolean;
}

export interface WindowCalculation {
  /** Optimal N (clamped to [MIN, MAX]). */
  optimalN: number;
  /** Whether this was computed adaptively or is a default. */
  adaptive: boolean;
  /** Breakdown of the calculation (for debugging). */
  breakdown: {
    contextWindowTokens: number;
    stableTokens: number;
    tailTokens: number;
    avgTokensPerTurn: number;
    rawN: number;
  };
}

/**
 * Calculate the optimal number of recent turns.
 *
 * When `adaptive` is false or `avgTokensPerTurn` is unavailable,
 * returns DEFAULT_RECENT_TURNS.
 */
export function calculateOptimalWindow(params: AdaptiveWindowParams): WindowCalculation {
  const contextWindowTokens = params.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
  const stableTokens = Math.ceil(params.stableAreaChars / CHARS_PER_TOKEN);
  const tailTokens = Math.ceil(params.tailChars / CHARS_PER_TOKEN);
  const adaptive = params.adaptive !== false && params.avgTokensPerTurn != null && params.avgTokensPerTurn > 0;

  let optimalN = DEFAULT_RECENT_TURNS;

  if (adaptive) {
    const avgT = params.avgTokensPerTurn!;
    const budget = contextWindowTokens - stableTokens - tailTokens;
    const rawN = Math.floor(budget / (2 * avgT));
    optimalN = Math.max(MIN_RECENT_TURNS, Math.min(MAX_RECENT_TURNS, rawN));
  }

  return {
    optimalN,
    adaptive,
    breakdown: {
      contextWindowTokens,
      stableTokens,
      tailTokens,
      avgTokensPerTurn: params.avgTokensPerTurn ?? 0,
      rawN: adaptive
        ? Math.floor((contextWindowTokens - stableTokens - tailTokens) / (2 * (params.avgTokensPerTurn ?? 1)))
        : DEFAULT_RECENT_TURNS,
    },
  };
}

/**
 * Maintain a rolling estimate of average tokens per turn.
 * Uses exponential moving average (EMA) with alpha=0.3 to smooth jitter.
 */
export class TurnTokenTracker {
  private ema: number | null = null;
  private alpha = 0.3;

  /** Record a turn's token count (user + assistant). */
  recordTurn(tokens: number): void {
    if (this.ema === null) {
      this.ema = tokens;
    } else {
      this.ema = this.alpha * tokens + (1 - this.alpha) * this.ema;
    }
  }

  /** Current EMA estimate. Returns 0 if no turns recorded. */
  get estimate(): number {
    return this.ema ?? 0;
  }

  /** Whether any turns have been recorded. */
  get hasData(): boolean {
    return this.ema !== null;
  }

  reset(): void {
    this.ema = null;
  }
}
