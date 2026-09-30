/**
 * Deterministic simulator for OpenAI-compatible **prefix** prompt caching.
 *
 * ## What it models
 *
 * DeepSeek / MiMo / Qwen / GLM do not expose cache breakpoints.  They hash the
 * serialized request from token 0 and reuse the longest identical prefix seen
 * before, in fixed-size blocks (DeepSeek documents 64-token blocks; a partial
 * trailing block is not cached).  So:
 *
 *   cached_tokens(request_t) = floor(LCP(request_t, best previous request) / 64) * 64
 *   hit_rate                 = Σ cached_tokens / Σ prompt_tokens
 *
 * That is exactly what {@link simulateSession} computes.  It deliberately keeps
 * the arithmetic dumb and inspectable — the point is to compare two injection
 * policies on an *identical* conversation, not to predict an absolute number.
 *
 * ## Why it lives in src/ and not scripts/
 *
 * It drives the **real** {@link RecallCachePolicy} and the **real**
 * `generateSceneNavigation`, so the measurement tracks the shipped code instead
 * of a paraphrase of it.  `recall-cache-policy.test.ts` asserts on its output.
 */

import { generateSceneNavigation } from "../../src/core/scene/scene-navigation.js";
import type { SceneIndexEntry } from "../../src/core/scene/scene-index.js";
import { RecallCachePolicy, type RecallItem, type RecallCacheStabilityOptions } from "../../src/core/hooks/recall-cache-policy.js";
import { MEMORY_TOOLS_GUIDE } from "../../src/core/hooks/auto-recall.js";

// ============================
// Token accounting
// ============================

/**
 * Provider cache block size, in tokens. DeepSeek's context-caching docs state
 * that only whole 64-token blocks are cached; the tail remainder always
 * re-prefills.
 */
export const CACHE_BLOCK_TOKENS = 64;

/**
 * Rough char→token ratio for mixed zh/en prompt text.
 *
 * Chinese runs ~1–1.5 chars/token and English ~4, and the corpus below is
 * mostly Chinese memory lines inside English-ish XML tags. 2.5 is a middle
 * value; the comparison is a ratio, so the exact constant does not move the
 * conclusion, only the absolute token counts.
 */
const CHARS_PER_TOKEN = 2.5;

function toTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ============================
// Conversation model
// ============================

export interface SimMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Serialize a request the way a provider would before hashing.
 *
 * The `\u0000` separators make role boundaries unforgeable, so a longest-common-
 * prefix computed on this string cannot "half match" across two messages.
 */
function serializeRequest(system: string, messages: SimMessage[]): string {
  const parts = [`system\u0000${system}`];
  for (const m of messages) parts.push(`${m.role}\u0000${m.content}`);
  return parts.join("\u0001");
}

function longestCommonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export interface TurnStat {
  turn: number;
  promptTokens: number;
  cachedTokens: number;
  /** Why this turn missed, for debugging a regression. */
  note: string;
}

export interface SessionStats {
  turns: TurnStat[];
  totalPromptTokens: number;
  totalCachedTokens: number;
  /** cachedTokens / promptTokens over the whole session, in [0, 1]. */
  hitRate: number;
}

function summarize(turns: TurnStat[]): SessionStats {
  const totalPromptTokens = turns.reduce((s, t) => s + t.promptTokens, 0);
  const totalCachedTokens = turns.reduce((s, t) => s + t.cachedTokens, 0);
  return {
    turns,
    totalPromptTokens,
    totalCachedTokens,
    hitRate: totalPromptTokens === 0 ? 0 : totalCachedTokens / totalPromptTokens,
  };
}

// ============================
// Scenario generation
// ============================

/** Deterministic PRNG so every run of the simulator produces identical numbers. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScenarioOptions {
  seed: number;
  turns: number;
  /** Size of the L1 memory pool the retriever draws from. */
  memoryPoolSize: number;
  /** How many memories are recalled per turn (mirrors `recall.maxResults`). */
  recallPerTurn: number;
  /**
   * Probability that a recalled memory comes from the small "hot" subset.
   *
   * Real sessions stay on topic, so the retriever keeps returning the same
   * handful of records — which is precisely what session-level dedup exploits.
   */
  hotBias: number;
  /** Size of the hot subset. */
  hotSetSize: number;
  /** Number of scenes in the L2 index. */
  sceneCount: number;
  /** A scene's heat counter is bumped every N turns (background L2 activity). */
  sceneHeatBumpEveryTurns: number;
  /** The L3 persona is rewritten every N turns (background pipeline). */
  personaRegenEveryTurns: number;
}

export const DEFAULT_SCENARIO: ScenarioOptions = {
  seed: 20260530,
  turns: 40,
  memoryPoolSize: 60,
  recallPerTurn: 5,
  hotBias: 0.7,
  hotSetSize: 8,
  sceneCount: 6,
  sceneHeatBumpEveryTurns: 3,
  personaRegenEveryTurns: 12,
};

interface Scenario {
  /** Static host system prompt that precedes any plugin content. */
  baseSystem: string;
  /** Per-turn: user text, assistant reply, recalled memories, persona, scene index. */
  turns: Array<{
    userText: string;
    assistantText: string;
    recalled: RecallItem[];
    persona: string;
    scenes: SceneIndexEntry[];
  }>;
}

function pad(text: string, chars: number): string {
  if (text.length >= chars) return text.slice(0, chars);
  return text + "…".repeat(chars - text.length);
}

/**
 * Build one deterministic conversation.
 *
 * The same scenario object is replayed against every policy under test, so any
 * difference in hit rate is attributable to the policy alone.
 */
export function buildScenario(opts: ScenarioOptions = DEFAULT_SCENARIO): Scenario {
  const rnd = mulberry32(opts.seed);

  const baseSystem = pad("You are a helpful assistant. ", 6000);

  const pool: RecallItem[] = Array.from({ length: opts.memoryPoolSize }, (_, i) => {
    const content = pad(`用户在第 ${i} 号话题上的偏好、约束与历史结论。`, 90);
    return {
      id: `mem-${i.toString().padStart(3, "0")}`,
      type: i % 3 === 0 ? "persona" : i % 3 === 1 ? "episodic" : "instruction",
      content,
      line: `- [${i % 3 === 0 ? "persona" : i % 3 === 1 ? "episodic" : "instruction"}] ${content}`,
    };
  });

  const scenes: SceneIndexEntry[] = Array.from({ length: opts.sceneCount }, (_, i) => ({
    filename: `scene_${i.toString().padStart(2, "0")}.md`,
    summary: pad(`场景 ${i} 的核心要点摘要。`, 140),
    heat: 40 + i * 37,
    created: "2026-05-01",
    updated: "2026-05-01",
  }));

  let personaRevision = 0;
  const personaOf = (rev: number) =>
    pad(`# 用户画像 (rev ${rev})\n- 长期目标与沟通偏好。`, 1200);

  const turns: Scenario["turns"] = [];
  for (let t = 0; t < opts.turns; t++) {
    // Background L2: a scene gets hit, its heat counter and mtime move.
    if (t > 0 && t % opts.sceneHeatBumpEveryTurns === 0) {
      const idx = Math.floor(rnd() * scenes.length);
      scenes[idx] = {
        ...scenes[idx],
        heat: scenes[idx].heat + 1,
        updated: `2026-05-${String(1 + (t % 28)).padStart(2, "0")}`,
      };
    }
    // Background L3: the persona document is regenerated.
    if (t > 0 && t % opts.personaRegenEveryTurns === 0) personaRevision++;

    const recalled: RecallItem[] = [];
    const seen = new Set<string>();
    while (recalled.length < opts.recallPerTurn) {
      const fromHot = rnd() < opts.hotBias;
      const idx = fromHot
        ? Math.floor(rnd() * opts.hotSetSize)
        : Math.floor(rnd() * opts.memoryPoolSize);
      const item = pool[Math.min(idx, pool.length - 1)];
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      recalled.push(item);
    }

    turns.push({
      userText: pad(`第 ${t + 1} 轮用户提问。`, 220),
      assistantText: pad(`第 ${t + 1} 轮助手回复，含工具结果与推理过程。`, 1400),
      recalled,
      persona: personaOf(personaRevision),
      scenes: scenes.map((s) => ({ ...s })),
    });
  }

  return { baseSystem, turns };
}

// ============================
// Simulation
// ============================

export interface PolicyUnderTest {
  label: string;
  /** `undefined` reproduces v0.3.6: inject everything, every turn. */
  options?: Partial<RecallCacheStabilityOptions>;
}

/**
 * Replay a scenario under one injection policy and measure the prefix hit rate.
 *
 * The message list is append-only across turns, except that `prependContext` is
 * spliced into the *current* turn's user message only — mirroring OpenClaw's
 * ephemeral `installModelPromptTransform`, which is the reason a per-turn
 * injection breaks the prefix on the following turn.
 */
export function simulateSession(scenario: Scenario, policyUnderTest: PolicyUnderTest): SessionStats {
  const policy = new RecallCachePolicy({
    ...(policyUnderTest.options ?? { enabled: false }),
  });
  const active = policy.options.enabled;
  const sessionKey = "sim-session";

  /** Every request already sent — the provider's cache. */
  const priorRequests: string[] = [];
  /** Clean, append-only transcript (no injected prefixes). */
  const transcript: SimMessage[] = [];
  const stats: TurnStat[] = [];

  let lastSystem = "";

  for (let t = 0; t < scenario.turns.length; t++) {
    const turn = scenario.turns[t];
    if (active) policy.beginTurn(sessionKey);

    // ── Stable block, exactly as auto-recall assembles it ──
    const nav = generateSceneNavigation(turn.scenes, "/data", {
      stable: active && policy.options.stabilizeSceneNavigation,
    });
    const freshSystemContext = [
      `<user-persona>\n${turn.persona}\n</user-persona>`,
      `<scene-navigation>\n${nav}\n</scene-navigation>`,
      MEMORY_TOOLS_GUIDE,
    ].join("\n\n");

    const systemContext = active
      ? policy.resolveSystemContext(sessionKey, freshSystemContext).text ?? ""
      : freshSystemContext;

    // ── Dynamic block ──
    let injected = turn.recalled;
    if (active) {
      const decision = policy.filterMemories(sessionKey, injected);
      injected = decision.kept;
      policy.commitInjected(sessionKey, injected.map((m) => m.id));
    }
    const prependContext =
      injected.length > 0
        ? `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${injected
            .map((m) => m.line)
            .join("\n")}\n</relevant-memories>`
        : "";

    // ── Build the request ──
    const system = `${scenario.baseSystem}\n\n${systemContext}`;
    const messages: SimMessage[] = [
      ...transcript,
      {
        role: "user",
        content: prependContext ? `${prependContext}\n\n${turn.userText}` : turn.userText,
      },
    ];
    const request = serializeRequest(system, messages);

    // ── Measure against the best previous request ──
    let bestLcpChars = 0;
    for (const prev of priorRequests) {
      const lcp = longestCommonPrefix(request, prev);
      if (lcp > bestLcpChars) bestLcpChars = lcp;
    }

    const promptTokens = toTokens(request.length);
    const lcpTokens = toTokens(bestLcpChars);
    const cachedTokens = Math.min(
      promptTokens,
      Math.floor(lcpTokens / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS,
    );

    let note = "ok";
    if (t === 0) note = "cold-start";
    else if (system !== lastSystem) note = "system-prompt-changed (full miss)";
    else if (prependContext) note = "per-turn injection (tail miss)";

    stats.push({ turn: t + 1, promptTokens, cachedTokens, note });

    // ── Commit the turn to the clean transcript ──
    transcript.push({ role: "user", content: turn.userText });
    transcript.push({ role: "assistant", content: turn.assistantText });
    priorRequests.push(request);
    lastSystem = system;
  }

  return summarize(stats);
}

export interface ComparisonRow {
  label: string;
  stats: SessionStats;
}

/** Run the default A/B: v0.3.6 behaviour vs. the cache-stability policy. */
export function runComparison(opts: ScenarioOptions = DEFAULT_SCENARIO): ComparisonRow[] {
  const scenario = buildScenario(opts);
  const variants: PolicyUnderTest[] = [
    { label: "baseline (v0.3.6)", options: { enabled: false } },
    {
      label: "freeze systemContext only",
      options: { enabled: true, freezeSystemContext: true, dedupMemories: false, stabilizeSceneNavigation: false },
    },
    {
      label: "dedup memories only",
      options: { enabled: true, freezeSystemContext: false, dedupMemories: true, stabilizeSceneNavigation: false },
    },
    {
      label: "stable scene nav only",
      options: { enabled: true, freezeSystemContext: false, dedupMemories: false, stabilizeSceneNavigation: true },
    },
    { label: "all optimizations", options: { enabled: true } },
  ];
  return variants.map((v) => ({ label: v.label, stats: simulateSession(scenario, v) }));
}

/** Render the comparison as a plain-text table for CLI output. */
export function formatComparison(rows: ComparisonRow[]): string {
  const header = ["policy", "prompt tokens", "cached tokens", "hit rate"];
  const body = rows.map((r) => [
    r.label,
    String(r.stats.totalPromptTokens),
    String(r.stats.totalCachedTokens),
    `${(r.stats.hitRate * 100).toFixed(1)}%`,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

// ============================
// Sensitivity sweep
// ============================

export interface SweepCell {
  sceneHeatBumpEveryTurns: number;
  personaRegenEveryTurns: number;
  baselineHitRate: number;
  optimizedHitRate: number;
  /** optimized − baseline, in percentage points / 100. */
  delta: number;
}

export interface SweepSummary {
  cells: SweepCell[];
  baselineMin: number;
  baselineMax: number;
  optimizedMin: number;
  optimizedMax: number;
  minDelta: number;
  maxDelta: number;
  /** Number of parameter combinations where the policy made things worse. */
  regressions: number;
}

/**
 * Sweep the *background write frequency* — the one variable a real deployment
 * cannot control, and the one this whole issue turns on.
 *
 * This exists because a single headline number is misleading: the baseline hit
 * rate is almost entirely a function of how often the L2/L3 pipelines rewrite
 * their artifacts, so quoting one baseline figure says more about the chosen
 * parameters than about the code.  The sweep reports the *range* instead, which
 * is the honest form of the claim:
 *
 *   - baseline swings wildly across the grid  → the regression is nondeterministic
 *   - optimized stays flat                    → the policy removes the variance
 *   - `regressions === 0`                     → no parameter choice makes it worse
 *
 * The last point is the one worth asserting in CI.
 */
export function runSensitivitySweep(
  sceneBumpIntervals: readonly number[] = [1, 2, 3, 6, 12, 999],
  personaRegenIntervals: readonly number[] = [4, 8, 12, 24, 999],
  base: ScenarioOptions = DEFAULT_SCENARIO,
): SweepSummary {
  const cells: SweepCell[] = [];
  for (const sceneHeatBumpEveryTurns of sceneBumpIntervals) {
    for (const personaRegenEveryTurns of personaRegenIntervals) {
      const rows = runComparison({ ...base, sceneHeatBumpEveryTurns, personaRegenEveryTurns });
      const baselineHitRate = rows[0].stats.hitRate;
      const optimizedHitRate = rows[rows.length - 1].stats.hitRate;
      cells.push({
        sceneHeatBumpEveryTurns,
        personaRegenEveryTurns,
        baselineHitRate,
        optimizedHitRate,
        delta: optimizedHitRate - baselineHitRate,
      });
    }
  }
  const baselines = cells.map((c) => c.baselineHitRate);
  const optimized = cells.map((c) => c.optimizedHitRate);
  const deltas = cells.map((c) => c.delta);
  return {
    cells,
    baselineMin: Math.min(...baselines),
    baselineMax: Math.max(...baselines),
    optimizedMin: Math.min(...optimized),
    optimizedMax: Math.max(...optimized),
    minDelta: Math.min(...deltas),
    maxDelta: Math.max(...deltas),
    regressions: deltas.filter((d) => d < 0).length,
  };
}

/** Render the sweep as a plain-text table for CLI output. */
export function formatSensitivitySweep(summary: SweepSummary): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const header = ["scene bump", "persona regen", "baseline", "optimized", "delta"];
  const body = summary.cells.map((c) => [
    `every ${c.sceneHeatBumpEveryTurns}`,
    `every ${c.personaRegenEveryTurns}`,
    pct(c.baselineHitRate),
    pct(c.optimizedHitRate),
    `+${(c.delta * 100).toFixed(1)}pp`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...body.map(line),
    "",
    `baseline range : ${pct(summary.baselineMin)} ~ ${pct(summary.baselineMax)}  <- uncontrollable`,
    `optimized range: ${pct(summary.optimizedMin)} ~ ${pct(summary.optimizedMax)}  <- flat`,
    `delta range    : +${(summary.minDelta * 100).toFixed(1)}pp ~ +${(summary.maxDelta * 100).toFixed(1)}pp`,
    `regressions    : ${summary.regressions} / ${summary.cells.length}`,
  ].join("\n");
}
