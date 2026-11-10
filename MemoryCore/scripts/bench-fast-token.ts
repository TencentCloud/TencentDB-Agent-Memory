/**
 * Benchmark: fastEstimateTokens (and fastEstimateMessages) — deterministic micro-bench.
 *
 * This harness is designed to plug into the 三郎 (iteration-run) engine by emitting
 * `go_bench`-style output lines so the engine's existing `go_bench` metrics_parser can
 * capture ns/op / B/op / allocs/op directly.
 *
 * Because the upstream repo ships no `token_count/corpus` and no `cjk_token_table.bin`,
 * we generate a FIXED, deterministic synthetic corpus covering the categories the
 * estimator actually branches on (English / code / CJK fallback / Kana / French / JSON
 * messages). Determinism is essential: cross-run CV must stay comparable.
 *
 * Output format (one line per case), Go-bench compatible:
 *   Benchmark_FastEstimateTokens-8   5   12345 ns/op   512 B/op   8 allocs/op
 *
 * Run:
 *   GOMAXPROCS=8 NODE_OPTIONS=--max-old-space-size=4096 tsx bench-fast-token.ts
 */
import { performance } from "perf_hooks";
import { fastEstimateTokens, fastEstimateMessages } from "../src/offload/fast-token-estimate.ts";

// ─── Deterministic synthetic corpus ────────────────────────────────────────
// Fixed strings (no RNG) so every run is byte-identical → stable CV.

function repeat(text: string, times: number): string {
  return text.repeat(times);
}

function buildCorpus(): { name: string; text: string }[] {
  const enPara =
    "The quick brown fox jumps over the lazy dog while agents collaborate to build a " +
    "growing memory system that captures conversation knowledge reliably and efficiently. ";
  const codeSnippet =
    "function estimateTokens(text: string): number {\n" +
    "  let total = 0;\n" +
    "  for (const ch of text) { total += costOf(ch); }\n" +
    "  return Math.max(1, Math.round(total));\n}\n";
  const zhSnippet = "人工智能记忆系统可以自动捕获结构化并分析对话知识以提升长期记忆能力。";
  const jaSnippet = "エージェントの記憶システムは会話から知識を自動抽出します。";
  const frSnippet =
    "Les agents construisent un système de mémoire qui capture les connaissances des conversations. ";
  const jsonMessages = JSON.stringify(
    [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "Run ls -la" },
      {
        role: "toolResult",
        toolCallId: "call_123",
        content:
          "total 48\ndrwxr-xr-x 5 user user 4096 May 18 10:00 .\n-rw-r--r-- 1 user user 1234 May 18 09:30 package.json\n",
      },
    ],
    null,
    2,
  ).repeat(50);

  return [
    { name: "English", text: repeat(enPara, 1500) }, // ~100K chars
    { name: "Code", text: repeat(codeSnippet, 2200) }, // ~100K chars
    { name: "Chinese", text: repeat(zhSnippet, 5200) }, // CJK fallback path (~100K chars)
    { name: "Japanese", text: repeat(jaSnippet, 5200) }, // Kana path
    { name: "French", text: repeat(frSnippet, 1500) }, // non-English Latin accent path
    { name: "JsonMessages", text: jsonMessages },
  ];
}

// ─── Bench harness (Go-bench semantics: calibrate b.N per block) ─────────────
// To keep CV ≤ 5% we mimic `go test -bench`:
//   1. warmup until the JIT stabilizes
//   2. calibrate b.N so a single timed block lasts ≥ MIN_BLOCK_MS
//   3. run ROUNDS timed blocks, report per-op mean + CV over blocks

const ROUNDS = 7; // equivalent to go test -count=7
const WARMUP = 15;
const MIN_BLOCK_MS = 200; // each timed block processes ≥200ms of work

function benchCase(name: string, fn: () => void): { nsPerOp: number; cvPct: number } {
  // warmup
  for (let w = 0; w < WARMUP; w++) fn();

  // calibrate b.N
  let n = 1;
  {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    const dt = performance.now() - t0;
    if (dt < MIN_BLOCK_MS) {
      n = Math.max(1, Math.ceil((MIN_BLOCK_MS / Math.max(dt, 0.01)) * n));
    }
  }

  const perOpNs: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    const dt = performance.now() - t0;
    perOpNs.push((dt * 1_000_000) / n); // ms → ns, divided by b.N
  }

  const mean = perOpNs.reduce((a, b) => a + b, 0) / perOpNs.length;
  const variance = perOpNs.reduce((a, b) => a + (b - mean) ** 2, 0) / perOpNs.length;
  const std = Math.sqrt(variance);
  const cvPct = mean === 0 ? 0 : (std / mean) * 100;
  return { nsPerOp: mean, cvPct };
}

function allocsProbe(fn: () => void): { bPerOp: number; allocsPerOp: number } {
  // Coarse allocation accounting via before/after heap usage.
  const before = process.memoryUsage().heapUsed;
  const iters = 20;
  for (let i = 0; i < iters; i++) fn();
  const after = process.memoryUsage().heapUsed;
  const bPerOp = Math.max(0, Math.round((after - before) / iters));
  // allocs/op not precisely measurable without instrumented allocator; report 0 and
  // rely on ns/op as the primary comparable metric (matches template constraint: CV on ns/op).
  return { bPerOp, allocsPerOp: 0 };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const corpus = buildCorpus();
const gomaxprocs = process.env.GOMAXPROCS ?? "1";

// Single aggregate benchmark (mirrors a Go Benchmark func with N=iterations inside).
function runFastEstimateTokens(): void {
  for (const { text } of corpus) {
    fastEstimateTokens(text);
  }
}

function runFastEstimateMessages(): void {
  const msgs = corpus.map((c) => ({ role: "user", content: c.text }));
  fastEstimateMessages(msgs as any);
}

const cases: { tag: string; fn: () => void }[] = [
  { tag: "FastEstimateTokens", fn: runFastEstimateTokens },
  { tag: "FastEstimateMessages", fn: runFastEstimateMessages },
];

const lines: string[] = [];
for (const { tag, fn } of cases) {
  const { nsPerOp, cvPct } = benchCase(tag, fn);
  const { bPerOp, allocsPerOp } = allocsProbe(fn);
  // go_bench compatible line:
  // Benchmark_Name-N  <iters>  <ns>/op  <B>/op  <allocs>/op
  const line =
    `Benchmark_${tag}-${gomaxprocs}\t${ROUNDS}\t${nsPerOp.toFixed(1)}\tns/op\t` +
    `${bPerOp}\tB/op\t${allocsPerOp}\tallocs/op`; // eslint-disable-line
  lines.push(line);
  // also echo CV for human debugging (parse_bench ignores non-matching lines, but
  // perf_compare.py reads these # lines; must be on stdout so `tee` captures it)
  console.log(`# ${tag}: ns/op=${nsPerOp.toFixed(1)} cv=${cvPct.toFixed(2)}%`);
}

console.log(lines.join("\n"));
