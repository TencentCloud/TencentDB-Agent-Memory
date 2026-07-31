/**
 * Quantify conversation-history bloat caused by `showInjected` (issue #120, 进阶).
 *
 * ## Why this file exists
 *
 * `prefix-cache-sim.ts` models only the `showInjected = false` path, where
 * `prependContext` is spliced into the *current* turn's user message and thrown
 * away afterwards.  The issue, however, names a different path as the PRIMARY
 * cause:
 *
 *   > 当 showInjected=true 时，这些内容被冻结写入对话历史中。
 *   > 多轮对话后，上下文快速膨胀。膨胀触发更频繁的 tool result truncation。
 *   > truncation 的截断量每轮不同 → 对话历史前缀不一致 → 缓存失效。
 *
 * That the pollution is real is not a guess — the plugin's own L0 recorder
 * documents it (`src/core/conversation/l0-recorder.ts:193`):
 *
 *   > The framework appends the user's message to the session after
 *   > before_prompt_build, then injects prependContext into it.
 *   > So the user message in rawMessages is polluted.
 *
 * The recorder caches `originalUserText` and swaps the clean prompt back in
 * *when writing L0*.  It does **not** repair the framework's session, so on the
 * next turn the history the model sees still carries the previous turns'
 * `<relevant-memories>` blocks.  Hence: cumulative.
 *
 * ## What is modelled, and what is not
 *
 * Modelled (arithmetic, no hidden constants beyond the ones named below):
 *   - per-turn token growth of the transcript under both `showInjected` modes;
 *   - how session-level dedup changes that growth;
 *   - the turn index at which a given context window starts truncating.
 *
 * NOT modelled: the truncation → prefix-inconsistency → cache-miss step.  That
 * behaviour lives in the host's tool-result truncator, which is a black box
 * here.  This module quantifies the *pressure*; it does not claim a hit rate.
 * Any number produced here is a token count, never a cache percentage.
 */

import { RecallCachePolicy, type RecallItem } from "../../src/core/hooks/recall-cache-policy.js";

/** Same rough char→token ratio the rest of the analysis uses (CJK-heavy text). */
export const CHARS_PER_TOKEN = 2.5;

export interface BloatOptions {
  turns: number;
  /** Memories recalled per turn, before dedup. */
  recallPerTurn: number;
  /** Characters per recalled memory line. */
  memoryChars: number;
  /** Characters of real user text per turn. */
  userChars: number;
  /** Characters of assistant reply per turn. */
  assistantChars: number;
  /**
   * Probability that a recalled memory is one already seen this session.
   *
   * Recall is relevance-ranked against a slowly-drifting conversation, so the
   * same high-scoring memories resurface constantly.  0.7 means 70% of a turn's
   * recall repeats something already injected — this is the single most
   * important knob and it is a *modelling assumption*, not a measurement.
   */
  repeatRate: number;
  /** Model context window in tokens; truncation begins once the prompt exceeds it. */
  contextWindow: number;
  /** Fixed system-prompt cost (base prompt + persona + scene nav + tools guide). */
  systemTokens: number;
}

export const DEFAULT_BLOAT: BloatOptions = {
  turns: 40,
  recallPerTurn: 5,
  memoryChars: 220,
  userChars: 300,
  assistantChars: 1400,
  repeatRate: 0.7,
  contextWindow: 64000,
  systemTokens: 2400,
};

export interface TurnBloat {
  turn: number;
  /** Tokens of `<relevant-memories>` injected on this turn alone. */
  injectedTokens: number;
  /** Cumulative transcript tokens (user + assistant + any frozen injections). */
  transcriptTokens: number;
  /** Full prompt = system + transcript. */
  promptTokens: number;
  /** How many tokens must be truncated to fit the window (0 = fits). */
  overflowTokens: number;
}

export interface BloatResult {
  label: string;
  turns: TurnBloat[];
  finalPromptTokens: number;
  /** Total tokens spent on memory injection across the session. */
  totalInjectedTokens: number;
  /** First turn where the prompt exceeds the context window, or null. */
  firstTruncationTurn: number | null;
}

const toTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

/** Wrapper overhead of the `<relevant-memories>` block (tag + Chinese preamble). */
const MEMORY_BLOCK_OVERHEAD_CHARS = 90;

/**
 * Deterministic pseudo-random stream.
 *
 * A fixed seed keeps every variant comparable: differences between runs come
 * from the policy under test, never from the RNG.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Build one turn's recall set.
 *
 * `repeatRate` of the picks are drawn from the pool of already-seen ids, the
 * rest are new — this is what makes session-level dedup worth anything.
 */
function recallForTurn(
  rng: () => number,
  opts: BloatOptions,
  seen: string[],
  nextId: { n: number },
): RecallItem[] {
  const out: RecallItem[] = [];
  for (let i = 0; i < opts.recallPerTurn; i++) {
    const reuse = seen.length > 0 && rng() < opts.repeatRate;
    const id = reuse ? seen[Math.floor(rng() * seen.length)] : `m${nextId.n++}`;
    if (!reuse) seen.push(id);
    out.push({
      id,
      type: "l1",
      line: `- [${id}] ${"记忆内容摘要。".repeat(Math.ceil(opts.memoryChars / 7)).slice(0, opts.memoryChars)}`,
      content: id,
    });
  }
  return out;
}

export interface BloatVariant {
  label: string;
  /** true = `prependContext` is frozen into conversation history. */
  showInjected: boolean;
  /** true = session-level dedup filters already-injected memories. */
  dedup: boolean;
}

export function simulateBloat(opts: BloatOptions, variant: BloatVariant): BloatResult {
  const rng = makeRng(0x5eed);
  const policy = new RecallCachePolicy({
    enabled: variant.dedup,
    dedupMemories: variant.dedup,
    // Isolate the dedup effect: no system-context freezing in this model.
    freezeSystemContext: false,
  });
  const sessionKey = "bloat-session";

  const seen: string[] = [];
  const nextId = { n: 0 };
  const turns: TurnBloat[] = [];

  let transcriptTokens = 0;
  let totalInjectedTokens = 0;
  let firstTruncationTurn: number | null = null;

  for (let t = 0; t < opts.turns; t++) {
    if (variant.dedup) policy.beginTurn(sessionKey);

    let recalled = recallForTurn(rng, opts, seen, nextId);
    if (variant.dedup) {
      const decision = policy.filterMemories(sessionKey, recalled);
      recalled = decision.kept;
      policy.commitInjected(sessionKey, recalled.map((m) => m.id));
    }

    const injectedChars =
      recalled.length > 0
        ? MEMORY_BLOCK_OVERHEAD_CHARS + recalled.reduce((s, m) => s + m.line.length, 0)
        : 0;
    const injectedTokens = toTokens(injectedChars);
    totalInjectedTokens += injectedTokens;

    // The clean turn content always lands in history.
    transcriptTokens += toTokens(opts.userChars) + toTokens(opts.assistantChars);

    // The injection lands in history only when showInjected is on.  Otherwise it
    // is spliced into the outgoing request and discarded — a per-turn cost that
    // never compounds.
    if (variant.showInjected) transcriptTokens += injectedTokens;

    const promptTokens =
      opts.systemTokens + transcriptTokens + (variant.showInjected ? 0 : injectedTokens);
    const overflowTokens = Math.max(0, promptTokens - opts.contextWindow);
    if (overflowTokens > 0 && firstTruncationTurn === null) firstTruncationTurn = t + 1;

    turns.push({
      turn: t + 1,
      injectedTokens,
      transcriptTokens,
      promptTokens,
      overflowTokens,
    });
  }

  return {
    label: variant.label,
    turns,
    finalPromptTokens: turns[turns.length - 1]?.promptTokens ?? 0,
    totalInjectedTokens,
    firstTruncationTurn,
  };
}

export const BLOAT_VARIANTS: BloatVariant[] = [
  { label: "showInjected=false (ephemeral)", showInjected: false, dedup: false },
  { label: "showInjected=true  (v0.3.6)", showInjected: true, dedup: false },
  { label: "showInjected=true  + dedup", showInjected: true, dedup: true },
];

export function runBloatComparison(opts: BloatOptions = DEFAULT_BLOAT): BloatResult[] {
  return BLOAT_VARIANTS.map((v) => simulateBloat(opts, v));
}

export function formatBloatComparison(results: BloatResult[], opts: BloatOptions = DEFAULT_BLOAT): string {
  const lines: string[] = [];
  lines.push(
    `context window ${opts.contextWindow} tok | ${opts.turns} turns | ` +
      `recall ${opts.recallPerTurn}/turn | repeatRate ${opts.repeatRate}`,
  );
  lines.push("");
  lines.push(
    "variant".padEnd(34) +
      "prompt@10".padStart(11) +
      "prompt@20".padStart(11) +
      "prompt@40".padStart(11) +
      "injected".padStart(11) +
      "truncates".padStart(11),
  );
  lines.push("-".repeat(89));

  for (const r of results) {
    const at = (n: number) => r.turns[Math.min(n, r.turns.length) - 1]?.promptTokens ?? 0;
    lines.push(
      r.label.padEnd(34) +
        String(at(10)).padStart(11) +
        String(at(20)).padStart(11) +
        String(at(40)).padStart(11) +
        String(r.totalInjectedTokens).padStart(11) +
        (r.firstTruncationTurn ? `turn ${r.firstTruncationTurn}` : "never").padStart(11),
    );
  }

  const ephemeral = results.find((r) => !r.label.includes("true"));
  const bloated = results.find((r) => r.label.includes("v0.3.6"));
  const deduped = results.find((r) => r.label.includes("dedup"));

  if (ephemeral && bloated && deduped) {
    lines.push("");
    const growth = bloated.finalPromptTokens - ephemeral.finalPromptTokens;
    const saved = bloated.finalPromptTokens - deduped.finalPromptTokens;
    lines.push(
      `showInjected=true costs +${growth} tok by turn ${opts.turns} ` +
        `(${((growth / ephemeral.finalPromptTokens) * 100).toFixed(1)}% larger prompt)`,
    );
    lines.push(
      `session dedup recovers ${saved} tok ` +
        `(${((saved / growth) * 100).toFixed(1)}% of the bloat)`,
    );
  }

  return lines.join("\n");
}
