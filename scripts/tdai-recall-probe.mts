/**
 * `tdai-recall-probe` — one command that measures recall and diffs it against
 * a baseline (tz-04 C2/C3).
 *
 * The gateway runs the same probe after every consolidation, but its numbers
 * arrive inside a run report and only as an aggregate. Tuning scoring needs
 * the opposite: run it on demand, over a fixed corpus, with the strata visible,
 * and compare with the measurement taken BEFORE the change.
 *
 * Everything about the model and the store comes from the gateway config, so
 * the measurement cannot drift from the pipeline it claims to measure. Scoring
 * knobs can be overridden per run (`--strategy`, `--threshold`) — that is the
 * sweep this package needs; the live config file is never written.
 *
 * Read-only by construction: the live store is refused unless `--allow-live`
 * is passed, and even then nothing is written to it.
 *
 * Usage:
 *   npx tsx scripts/tdai-recall-probe.mts --db /tmp/copy/vectors.db \
 *     [--data-dir DIR] [--corpus FILE] [--strategy keyword|embedding|hybrid] \
 *     [--threshold N] [--top-k N] [--cross-project-decay N] [--cross-multiplier N] \
 *     [--out FILE] [--compare BASELINE] [--allow-live]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadGatewayConfig } from "../src/gateway/config.js";
import { resolveUnderRoot } from "../src/gateway/tdai-root.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";
import { VectorStore } from "../src/core/store/sqlite.js";
import {
  runRecallProbe,
  type ProbeMetrics,
  type ProbeResult,
  type StratumKey,
} from "../src/gateway/probe.js";
import type { MemoryTdaiConfig } from "../src/config.js";

/** A stratum with fewer pairs than this is noise, and is printed as such. */
const INDICATIVE_BELOW = 20;

interface Args {
  db: string;
  dataDir: string;
  corpus: string;
  strategy?: "keyword" | "embedding" | "hybrid";
  threshold?: number;
  crossProjectDecay?: number;
  crossMultiplier?: number;
  topK?: number;
  out: string;
  compare: string;
  allowLive: boolean;
}

const USAGE =
  "usage: tdai-recall-probe.mts [--db FILE] [--data-dir DIR] [--corpus FILE]\n" +
  "       [--strategy keyword|embedding|hybrid] [--threshold N] [--top-k N]\n" +
  "       [--cross-project-decay N] [--cross-multiplier N]\n" +
  "       [--out FILE] [--compare BASELINE] [--allow-live]";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "",
    dataDir: "",
    corpus: "",
    out: "",
    compare: "",
    allowLive: false,
  };
  const number = (raw: string | undefined, flag: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value))
      throw new Error(`${flag} ждёт число, а получил "${raw}"`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--data-dir") args.dataDir = argv[++i] ?? "";
    else if (arg === "--corpus") args.corpus = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--compare") args.compare = argv[++i] ?? "";
    else if (arg === "--allow-live") args.allowLive = true;
    else if (arg === "--threshold")
      args.threshold = number(argv[++i], "--threshold");
    else if (arg === "--cross-project-decay")
      args.crossProjectDecay = number(argv[++i], "--cross-project-decay");
    else if (arg === "--cross-multiplier")
      args.crossMultiplier = number(argv[++i], "--cross-multiplier");
    else if (arg === "--top-k") args.topK = number(argv[++i], "--top-k");
    else if (arg === "--strategy") {
      const value = argv[++i] ?? "";
      if (value !== "keyword" && value !== "embedding" && value !== "hybrid") {
        throw new Error(
          `--strategy ждёт keyword|embedding|hybrid, а получил "${value}"`,
        );
      }
      args.strategy = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`неизвестный аргумент "${arg}"\n${USAGE}`);
  }
  return args;
}

/** Four numbers on one line, at a fixed width so columns line up. */
function metricsLine(m: ProbeMetrics): string {
  const f = (value: number): string => value.toFixed(3);
  return `P@5=${f(m.precisionAt5)} P@10=${f(m.precisionAt10)} R@5=${f(m.recallAt5)} R@10=${f(m.recallAt10)}`;
}

/** Signed delta in percentage points — the unit the acceptance criteria use. */
function deltaLine(now: ProbeMetrics, before: ProbeMetrics): string {
  const pp = (a: number, b: number): string => {
    const diff = (a - b) * 100;
    return `${diff >= 0 ? "+" : ""}${diff.toFixed(1)}пп`;
  };
  return (
    `ΔP@5=${pp(now.precisionAt5, before.precisionAt5)} ` +
    `ΔP@10=${pp(now.precisionAt10, before.precisionAt10)} ` +
    `ΔR@5=${pp(now.recallAt5, before.recallAt5)} ` +
    `ΔR@10=${pp(now.recallAt10, before.recallAt10)}`
  );
}

/** Read a previous measurement to compare against; throws when unusable. */
function loadBaseline(file: string): ProbeResult {
  const parsed = JSON.parse(
    fs.readFileSync(file, "utf-8"),
  ) as Partial<ProbeResult>;
  if (!parsed.metrics || !parsed.strata) {
    throw new Error(`${file} не похож на baseline: нет metrics/strata`);
  }
  return parsed as ProbeResult;
}

function printReport(result: ProbeResult, baseline: ProbeResult | null): void {
  console.log(`время:    ${result.at}`);
  console.log(`скоринг:  ${result.scoringVersion}`);
  console.log(
    `статус:   ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
  );
  console.log(`запросов: ${result.queries}, top-k: ${result.topK}`);
  console.log(`агрегат:  ${metricsLine(result.metrics)}`);
  if (baseline) {
    console.log(`baseline: ${metricsLine(baseline.metrics)}`);
    console.log(`дельта:   ${deltaLine(result.metrics, baseline.metrics)}`);
    const baselineHash = (baseline as { corpusHash?: string }).corpusHash;
    if (baselineHash && baselineHash !== corpusHash) {
      console.log(
        `  ⚠ baseline снимали на другом корпусе (sha256:${baselineHash})`,
      );
    }
    if (baseline.scoringVersion !== result.scoringVersion) {
      console.log(`  (скоринг baseline отличался: ${baseline.scoringVersion})`);
    }
  }
  // The old aggregate stays visible: reports and the digest still read it, and
  // it now counts on top-10 instead of top-3.
  console.log(
    `прежние:  precision@k=${result.precisionAtK ?? "—"} top1=${result.top1HitRate ?? "—"} утечка=${result.leakageRate ?? "—"}`,
  );

  const keys = Object.keys(result.strata).sort() as StratumKey[];
  console.log(`страты (${keys.length}):`);
  if (keys.length === 0)
    console.log("  (корпус без разметки expectedType/scopeRelation)");
  for (const key of keys) {
    const stratum = result.strata[key]!;
    const mark = stratum.queries < INDICATIVE_BELOW ? " ⚠ индикативная" : "";
    const before = baseline?.strata?.[key];
    const delta = before ? `  ${deltaLine(stratum, before)}` : "";
    console.log(
      `  ${key.padEnd(22)} пар=${String(stratum.queries).padStart(3)} ${metricsLine(stratum)}${delta}${mark}`,
    );
  }

  if (result.diagnostics.length > 0) {
    console.log(`диагностика (${result.diagnostics.length}):`);
    for (const d of result.diagnostics.slice(0, 10)) {
      console.log(`  [${d.stage}] ${d.code} ${d.message}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const gatewayConfig = loadGatewayConfig();
const embeddingConfig = gatewayConfig.memory.embedding;

const liveDb = resolveUnderRoot(gatewayConfig.data.baseDir, "vectors.db");
const dbPath = args.db || liveDb;
if (path.resolve(dbPath) === path.resolve(liveDb) && !args.allowLive) {
  console.error(
    `отказ: ${dbPath} — боевой стор. Измеряй копию (--db /tmp/…/vectors.db) ` +
      `или подтверди явно флагом --allow-live.`,
  );
  process.exit(2);
}
const dataDir = args.dataDir || path.dirname(dbPath);

const cfg: MemoryTdaiConfig = {
  ...gatewayConfig.memory,
  recall: {
    ...gatewayConfig.memory.recall,
    ...(args.strategy ? { strategy: args.strategy } : {}),
    ...(args.threshold !== undefined ? { scoreThreshold: args.threshold } : {}),
    ...(args.crossProjectDecay !== undefined
      ? { crossProjectDecay: args.crossProjectDecay }
      : {}),
    ...(args.crossMultiplier !== undefined
      ? { defaultCrossProjectMultiplier: args.crossMultiplier }
      : {}),
  },
  probe: {
    ...gatewayConfig.memory.probe,
    ...(args.corpus ? { corpusPath: args.corpus } : {}),
    ...(args.topK !== undefined ? { topK: args.topK } : {}),
  },
};

if (!embeddingConfig.enabled || !embeddingConfig.apiKey) {
  console.error(
    `эмбеддинги не настроены в конфиге гейтвея (provider=${embeddingConfig.provider}) — ` +
      `probe сможет мерить только strategy=keyword`,
  );
}

const embeddingService = createEmbeddingService({
  provider: embeddingConfig.provider,
  baseUrl: embeddingConfig.baseUrl,
  apiKey: embeddingConfig.apiKey,
  model: embeddingConfig.model,
  dimensions: embeddingConfig.dimensions,
  sendDimensions: embeddingConfig.sendDimensions,
  sendInputType: embeddingConfig.sendInputType,
  maxInputChars: embeddingConfig.maxInputChars,
  timeoutMs: embeddingConfig.timeoutMs,
});

const store = new VectorStore(dbPath, embeddingConfig.dimensions);
store.init({
  provider: embeddingConfig.provider,
  model: embeddingConfig.model,
});

const baseline = args.compare ? loadBaseline(args.compare) : null;

const result = await runRecallProbe({
  dataDir,
  cfg,
  vectorStore: store,
  embeddingService,
});
store.close();

const corpusFile = path.isAbsolute(cfg.probe.corpusPath)
  ? cfg.probe.corpusPath
  : path.join(dataDir, cfg.probe.corpusPath);
// The corpus itself never leaves the machine (personal memory), so the baseline
// carries its hash instead: two measurements are only comparable when the
// questions were the same.
const corpusHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync(corpusFile))
  .digest("hex")
  .slice(0, 16);

console.log(`стор:     ${dbPath}`);
console.log(`корпус:   ${corpusFile} (sha256:${corpusHash})`);
printReport(result, baseline);

if (args.out) {
  // Only the aggregate leaves the machine: `evaluated` carries the retrieved
  // CONTENT of personal memory, and this file is meant to be committable.
  // Diagnostics are folded into counts for the same reason they are not
  // printed in full — one line per query says nothing a total does not.
  const { evaluated: _evaluated, diagnostics, ...aggregate } = result;
  const diagnosticCounts: Record<string, number> = {};
  for (const d of diagnostics) {
    const key = `${d.stage}:${d.code}`;
    diagnosticCounts[key] = (diagnosticCounts[key] ?? 0) + 1;
  }
  fs.writeFileSync(
    args.out,
    `${JSON.stringify({ ...aggregate, diagnosticCounts, corpusHash }, null, 2)}\n`,
    "utf-8",
  );
  console.log(`записано: ${args.out} (без содержимого записей)`);
}

process.exit(result.status === "ok" ? 0 : 1);
