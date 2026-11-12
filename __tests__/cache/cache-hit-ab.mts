/**
 * Real-machine A/B for prompt-cache hit rate (issue #120).
 *
 * The numbers in ISSUE-120-CACHE-ANALYSIS.md §4 come from a local simulator and
 * are explicitly NOT measurements.  This script produces the real thing by
 * reading the cache counters the provider itself reports:
 *
 *   DeepSeek : usage.prompt_cache_hit_tokens / usage.prompt_cache_miss_tokens
 *   generic  : usage.prompt_tokens_details.cached_tokens
 *
 * It talks to the provider directly over the OpenAI-compatible endpoint and
 * replays a multi-turn conversation, so it measures the *provider's* caching
 * behaviour without needing OpenClaw in the loop.  To A/B the plugin end-to-end
 * instead, see "Mode B" at the bottom.
 *
 * Usage:
 *   export DEEPSEEK_API_KEY=sk-...
 *   node node_modules/tsx/dist/cli.mjs scripts/cache-hit-ab.mts
 *
 *   # or point it at any OpenAI-compatible endpoint
 *   CACHE_AB_BASE_URL=https://api.deepseek.com \
 *   CACHE_AB_MODEL=deepseek-chat \
 *   CACHE_AB_KEY=sk-... \
 *   node node_modules/tsx/dist/cli.mjs scripts/cache-hit-ab.mts
 *
 * Cost: ~40 turns x 2 arms x 3 repeats. Keep TURNS small while smoke-testing.
 */

import { readFileSync, existsSync } from "node:fs";

/**
 * Minimal .env loader.
 *
 * Deliberately does not pull in `dotenv`: this script must be runnable from a
 * checkout with a broken `node_modules/.bin`, and the format we need is one
 * `KEY = value` per line.  Existing process env always wins so a one-off
 * override on the command line still works.
 */
function loadDotEnv(file = ".env"): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadDotEnv();

const BASE_URL =
  process.env.CACHE_AB_BASE_URL ?? process.env.BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.CACHE_AB_MODEL ?? "deepseek-chat";
const API_KEY =
  process.env.CACHE_AB_KEY ??
  process.env.DEEPSEEK_API_KEY ??
  process.env.API_KEY ??
  process.env.OPENAI_API_KEY;
const TURNS = Number(process.env.CACHE_AB_TURNS ?? 20);
const REPEATS = Number(process.env.CACHE_AB_REPEATS ?? 3);
/** Keep replies short: we are measuring prompt caching, not generation. */
const MAX_TOKENS = Number(process.env.CACHE_AB_MAX_TOKENS ?? 64);

if (!API_KEY) {
  console.error(
    "Missing API key. Set CACHE_AB_KEY (or DEEPSEEK_API_KEY / OPENAI_API_KEY).\n" +
      "This script makes real, billable API calls.",
  );
  process.exit(1);
}

interface Usage {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface TurnMeasurement {
  turn: number;
  promptTokens: number;
  cachedTokens: number;
}

/** Extract cached-prompt-token count across the known field spellings. */
function readCachedTokens(usage: Usage): number {
  if (typeof usage.prompt_cache_hit_tokens === "number") return usage.prompt_cache_hit_tokens;
  if (typeof usage.prompt_tokens_details?.cached_tokens === "number") {
    return usage.prompt_tokens_details.cached_tokens;
  }
  return 0;
}

async function chat(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): Promise<Usage> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: MAX_TOKENS,
      temperature: 0,
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const json = (await res.json()) as { usage?: Usage };
  if (!json.usage) throw new Error("response carried no usage block");
  return json.usage;
}

/**
 * Filler that is honest about its token count.
 *
 * An earlier version padded with a repeated "…".  That looked like thousands of
 * characters but collapsed into very few tokens, so the "shared 4000-char head"
 * the A/B relied on was in fact below DeepSeek's 64-token caching floor — which
 * is why the churning arm reported a flat 0.0% and looked far worse than it is.
 * Repeating natural prose keeps chars and tokens roughly proportional.
 */
const FILLER =
  "The assistant keeps a durable record of the user's projects, preferences and prior decisions, " +
  "and consults that record before answering so its guidance stays consistent between sessions. ";

function pad(text: string, chars: number): string {
  if (text.length >= chars) return text.slice(0, chars);
  const need = chars - text.length;
  return text + FILLER.repeat(Math.ceil(need / FILLER.length)).slice(0, need);
}

/**
 * Unique per invocation of this script.
 *
 * DeepSeek's context cache survives for hours across requests, which quietly
 * destroys a naive A/B:
 *
 *   - both arms share the same multi-KB base system prompt, so whichever arm
 *     runs second inherits the first arm's cached prefix and scores too high;
 *   - repeat 2 inherits repeat 1, so the numbers drift upward each round.
 *
 * Prefixing every request with a nonce that is unique per (run, repeat, arm)
 * forces a genuinely cold cache for each measurement, which is the only way the
 * two arms are comparable.
 */
const RUN_NONCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function cacheIsolationPrefix(repeat: number, arm: string): string {
  return `[run ${RUN_NONCE} r${repeat} ${arm}]\n`;
}

const BASE_SYSTEM = pad("You are a helpful assistant. ", 4000);

/**
 * Build the plugin's system-prompt tail for a given turn.
 *
 * `churn: true` reproduces v0.3.6 — the scene-navigation block carries a raw
 * heat counter and an mtime, so background activity rewrites it constantly.
 * `churn: false` reproduces the cache-stability policy: the tail is frozen.
 */
function systemContextFor(turn: number, churn: boolean): string {
  const heat = churn ? `**热度**: ${100 + turn} | **更新**: 2026-05-${String(1 + (turn % 28)).padStart(2, "0")}` : "**热度**: 中 🔥🔥";
  const persona = churn ? `# 用户画像 (rev ${Math.floor(turn / 4)})` : "# 用户画像";
  return [
    `<user-persona>\n${persona}\n${pad("- 长期目标与沟通偏好。", 800)}\n</user-persona>`,
    `<scene-navigation>\n### Path: /data/scene_blocks/scene_00.md\n${heat}\nSummary: ${pad("场景核心要点。", 400)}\n</scene-navigation>`,
  ].join("\n\n");
}

async function runArm(
  label: string,
  arm: string,
  churn: boolean,
  repeat: number,
): Promise<TurnMeasurement[]> {
  const transcript: Array<{ role: string; content: string }> = [];
  const out: TurnMeasurement[] = [];
  const isolation = cacheIsolationPrefix(repeat, arm);

  for (let t = 0; t < TURNS; t++) {
    const systemPrompt = `${isolation}${BASE_SYSTEM}\n\n${systemContextFor(t, churn)}`;
    const userText = pad(`第 ${t + 1} 轮提问：请简短回答。`, 200);
    const usage = await chat(systemPrompt, [...transcript, { role: "user", content: userText }]);

    out.push({
      turn: t + 1,
      promptTokens: usage.prompt_tokens ?? 0,
      cachedTokens: readCachedTokens(usage),
    });

    transcript.push({ role: "user", content: userText });
    transcript.push({ role: "assistant", content: pad(`第 ${t + 1} 轮回复。`, 300) });
    process.stdout.write(`\r  ${label}: turn ${t + 1}/${TURNS}   `);
  }
  process.stdout.write("\r" + " ".repeat(48) + "\r");

  // Per-turn detail matters here: an aggregate alone cannot distinguish
  // "steadily mediocre" from "alternating 0% / 90%", and those two imply very
  // different root causes.
  const perTurn = out
    .map((m) => (m.promptTokens ? Math.round((m.cachedTokens / m.promptTokens) * 100) : 0))
    .map((p) => String(p).padStart(3));
  console.log(`  ${label}`);
  console.log(`    per-turn hit%: ${perTurn.join(" ")}`);
  return out;
}

function hitRate(ms: TurnMeasurement[]): number {
  const p = ms.reduce((s, m) => s + m.promptTokens, 0);
  const c = ms.reduce((s, m) => s + m.cachedTokens, 0);
  return p === 0 ? 0 : c / p;
}

/**
 * Hit rate excluding turn 1.
 *
 * Turn 1 is a guaranteed total miss for both arms (nothing is cached yet), so
 * including it drags both numbers down by an amount that depends only on how
 * many turns were run.  Steady-state is the figure that actually describes a
 * long-running session.
 */
function steadyStateHitRate(ms: TurnMeasurement[]): number {
  return hitRate(ms.slice(1));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  console.log(`endpoint : ${BASE_URL}`);
  console.log(`model    : ${MODEL}`);
  console.log(`turns    : ${TURNS}  repeats: ${REPEATS}`);
  console.log("");

  const churnRates: number[] = [];
  const frozenRates: number[] = [];
  const churnSteady: number[] = [];
  const frozenSteady: number[] = [];

  for (let r = 0; r < REPEATS; r++) {
    console.log(`--- repeat ${r + 1}/${REPEATS} ---`);

    // Each arm gets its own nonce, so neither can inherit the other's cached
    // prefix.  Alternating the order on top of that removes any residual
    // ordering effect (rate limits, provider-side warmup) from the comparison.
    const churnFirst = r % 2 === 0;
    const runChurn = () => runArm("churning tail (v0.3.6)", "churn", true, r);
    const runFrozen = () => runArm("frozen tail  (policy)", "frozen", false, r);

    const [churnMs, frozenMs] = churnFirst
      ? [await runChurn(), await runFrozen()]
      : await (async () => {
          const f = await runFrozen();
          return [await runChurn(), f] as const;
        })();

    churnRates.push(hitRate(churnMs));
    frozenRates.push(hitRate(frozenMs));
    churnSteady.push(steadyStateHitRate(churnMs));
    frozenSteady.push(steadyStateHitRate(frozenMs));
  }

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const a = median(churnRates);
  const b = median(frozenRates);
  const aSteady = median(churnSteady);
  const bSteady = median(frozenSteady);

  console.log("\n=== measured (provider-reported cache counters) ===");
  console.log(`nonce : ${RUN_NONCE}   (cache isolated per repeat x arm)`);
  console.log("");
  console.log("whole session (turn 1 included — turn 1 is a guaranteed miss):");
  console.log(`  churning system tail (v0.3.6) : ${pct(a)}   raw: ${churnRates.map(pct).join(", ")}`);
  console.log(`  frozen system tail   (policy) : ${pct(b)}   raw: ${frozenRates.map(pct).join(", ")}`);
  console.log(`  delta                         : ${b >= a ? "+" : ""}${((b - a) * 100).toFixed(1)}pp`);
  console.log("");
  console.log("steady state (turn 1 excluded — describes a long-running session):");
  console.log(
    `  churning system tail (v0.3.6) : ${pct(aSteady)}   raw: ${churnSteady.map(pct).join(", ")}`,
  );
  console.log(
    `  frozen system tail   (policy) : ${pct(bSteady)}   raw: ${frozenSteady.map(pct).join(", ")}`,
  );
  console.log(
    `  delta                         : ${bSteady >= aSteady ? "+" : ""}${((bSteady - aSteady) * 100).toFixed(1)}pp`,
  );
  console.log(
    "\nNote: this isolates the system-prompt-tail effect only.\n" +
      "For an end-to-end plugin A/B, run OpenClaw twice with\n" +
      "  recall.cacheStability.enabled = false / true\n" +
      "on an identical scripted conversation and diff the same usage fields.",
  );
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
