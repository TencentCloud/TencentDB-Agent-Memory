/**
 * Probe: at what granularity does the provider's prefix cache actually match?
 *
 * The A/B in `cache-hit-ab.mts` produced 0.0% for the churning arm, even though
 * both arms share a multi-thousand-token system prefix.  A token-level
 * longest-common-prefix cache (which is what the simulator in
 * `prefix-cache-sim.ts` models) would have returned partial credit for that
 * shared head.  Getting 0 instead means one of:
 *
 *   H1  the cache key is message-aligned — if the system *message* differs at
 *       all, nothing from that message onward is reusable;
 *   H2  the shared prefix is actually shorter than the 64-token minimum, so
 *       there was never anything to cache;
 *   H3  cache writes need more time / more requests to materialise.
 *
 * These have very different implications for issue #120, so measure instead of
 * guessing.  Every probe prints the raw provider counters.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/cache-granularity-probe.mts
 */

import { readFileSync, existsSync } from "node:fs";

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

if (!API_KEY) {
  console.error("Missing API key (CACHE_AB_KEY / DEEPSEEK_API_KEY).");
  process.exit(1);
}

interface Usage {
  prompt_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function cached(u: Usage): number {
  if (typeof u.prompt_cache_hit_tokens === "number") return u.prompt_cache_hit_tokens;
  return u.prompt_tokens_details?.cached_tokens ?? 0;
}

async function chat(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
): Promise<Usage> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  const json = (await res.json()) as { usage?: Usage };
  if (!json.usage) throw new Error("no usage block");
  return json.usage;
}

const NONCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let probeSeq = 0;

/** Distinct head per probe so probes cannot warm each other's cache. */
function head(): string {
  return `[probe ${NONCE} #${probeSeq++}]\n`;
}

/**
 * Real prose, not padding characters.
 *
 * An earlier version padded with a repeated "…", which risks tokenising into
 * far fewer tokens than the character count suggests — that alone could explain
 * H2.  Repeating a natural sentence keeps the token count honest and close to
 * what a real system prompt looks like.
 */
function prose(sentences: number): string {
  const s =
    "The assistant maintains a durable memory of the user's projects, preferences and prior decisions, " +
    "and consults that memory before answering so that guidance stays consistent across sessions. ";
  return s.repeat(sentences);
}

function report(label: string, u: Usage): void {
  const p = u.prompt_tokens ?? 0;
  const c = cached(u);
  const pctText = p ? `${((c / p) * 100).toFixed(1)}%` : "n/a";
  console.log(`  ${label.padEnd(34)} prompt=${String(p).padStart(5)}  cached=${String(c).padStart(5)}  ${pctText}`);
}

async function main() {
  console.log(`endpoint : ${BASE_URL}`);
  console.log(`model    : ${MODEL}`);
  console.log(`nonce    : ${NONCE}\n`);

  const LONG = prose(60); // target: comfortably over the 64-token minimum

  // --- Probe 0: sanity. Identical system + identical messages, sent twice. ---
  console.log("probe 0 — identical prompt twice (cache must work at all)");
  const h0 = head();
  const sys0 = `${h0}${LONG}`;
  report("  1st (cold)", await chat(sys0, [{ role: "user", content: "Say ok." }]));
  report("  2nd (identical)", await chat(sys0, [{ role: "user", content: "Say ok." }]));
  console.log("");

  // --- Probe 1: system identical, conversation grows. -----------------------
  // This is the "frozen tail" shape. Expect a healthy hit on turn 2+.
  console.log("probe 1 — system frozen, transcript grows");
  const h1 = head();
  const sys1 = `${h1}${LONG}`;
  const t1: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < 3; i++) {
    const user = `Turn ${i + 1}: ${prose(4)}`;
    report(`  turn ${i + 1}`, await chat(sys1, [...t1, { role: "user", content: user }]));
    t1.push({ role: "user", content: user });
    t1.push({ role: "assistant", content: "ok" });
  }
  console.log("");

  // --- Probe 2: system TAIL churns, long shared head. -----------------------
  // The decisive test.  The head is identical and large; only the last line of
  // the system message differs.  Token-level LCP => big partial hit.
  //                              Message-aligned => zero.
  console.log("probe 2 — system head identical, only system TAIL differs");
  const h2 = head();
  const t2: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < 3; i++) {
    const sys = `${h2}${LONG}\n\n<scene-navigation>heat=${100 + i} updated=2026-05-${10 + i}</scene-navigation>`;
    const user = `Turn ${i + 1}: ${prose(4)}`;
    report(`  turn ${i + 1} (tail rev ${i})`, await chat(sys, [...t2, { role: "user", content: user }]));
    t2.push({ role: "user", content: user });
    t2.push({ role: "assistant", content: "ok" });
  }
  console.log("");

  // --- Probe 3: system frozen, but an EARLY user message is rewritten. ------
  // Isolates whether the message-alignment effect (if any) is specific to the
  // system message or applies to any message in the array.
  console.log("probe 3 — system frozen, earliest user message rewritten each turn");
  const h3 = head();
  const sys3 = `${h3}${LONG}`;
  for (let i = 0; i < 3; i++) {
    const msgs = [
      { role: "user", content: `First message, revision ${i}. ${prose(4)}` },
      { role: "assistant", content: "ok" },
      { role: "user", content: `Second message, stable. ${prose(4)}` },
    ];
    report(`  turn ${i + 1} (first msg rev ${i})`, await chat(sys3, msgs));
  }
  console.log("");

  console.log("interpretation:");
  console.log("  probe 2 ~= probe 1  -> token-level prefix cache (simulator model is right)");
  console.log("  probe 2 == 0        -> message-aligned cache: ANY system churn voids the WHOLE prompt");
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
