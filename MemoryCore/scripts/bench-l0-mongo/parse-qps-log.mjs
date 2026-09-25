/**
 * Reconstruct a bench report JSON from a raw bench log's [qps] lines.
 *
 * Used to rescue the write-throughput curve of a run that was interrupted before
 * it could persist its own report (the in-memory report is only written after
 * the write+query phases complete). Emits a `l0-mongo-bench/v2`-shaped JSON so
 * view-report.html renders the throughput-over-time chart, and refreshes
 * reports/index.json.
 *
 * Usage: node parse-qps-log.mjs <raw.log> <out-name.json>
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(__dirname, "reports");

const src = process.argv[2];
const outName = process.argv[3] ?? "l0-bench-rescued.json";
if (!src || !existsSync(src)) {
  console.error(`source log not found: ${src}`);
  process.exit(1);
}

const text = readFileSync(src, "utf8");
const lines = text.split("\n");

const numOf = (s) => Number(String(s).replace(/,/g, ""));
const tsOf = (line) => {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
  return m ? new Date(m[1].replace(" ", "T")).getTime() : null;
};

// Header: host + concurrency.
let uriHost = "unknown";
let concurrency = 0;
for (const l of lines) {
  const h = l.match(/host=(\S+)\s+concurrency=(\d+)/);
  if (h) {
    uriHost = h[1];
    concurrency = Number(h[2]);
    break;
  }
}

// Canary line(s).
const canary = { docs: 0, ftsVisibilityMs: -1, hits: 0, usable: false, indexReadyPollMs: 0, indexReadySinceInitMs: 0 };
for (const l of lines) {
  const r = l.match(/queryable=(\w+) — took (\d+)ms of post-data polling \((\d+)ms since index creation\)/);
  if (r) {
    canary.indexReadyPollMs = Number(r[2]);
    canary.indexReadySinceInitMs = Number(r[3]);
  }
  const ok = l.match(/\[canary\] OK — \$search returned (\d+) hits after (\d+)ms on (\d+) docs/);
  if (ok) {
    canary.hits = Number(ok[1]);
    canary.ftsVisibilityMs = Number(ok[2]);
    canary.docs = Number(ok[3]);
    canary.usable = true;
  }
}

// [qps] samples: parse wall-clock, docs, inst, avg.
const qps = [];
for (const l of lines) {
  if (!l.includes("[qps]")) continue;
  const d = l.match(/docs=([\d,]+)\//);
  const inst = l.match(/inst=([\d,]+)\/s/);
  const avg = l.match(/avg=([\d,]+)\/s/);
  const t = tsOf(l);
  if (!d || !inst || !avg || t == null) continue;
  qps.push({ t, docs: numOf(d[1]), inst: numOf(inst[1]), avg: numOf(avg[1]) });
}
if (qps.length < 2) {
  console.error("not enough [qps] lines parsed");
  process.exit(1);
}

const t0 = qps[0].t;
// First sample lands ~one sampling interval after the write started; offset so
// x=0 is the write start, not the first sample.
const firstInterval = qps.length > 1 ? qps[1].t - qps[0].t : 60_000;
const samples = qps.map((s) => ({
  tMs: s.t - t0 + firstInterval,
  docs: s.docs,
  intervalDocsPerSec: s.inst,
  cumulativeDocsPerSec: s.avg,
}));

const errors = (text.match(/\[insert\] batch @\d+ failed/g) || []).length;

const startedAt = new Date(tsOf(lines.find((l) => tsOf(l) != null)) ?? t0).toISOString();
const finishedAt = new Date(qps[qps.length - 1].t).toISOString();
const last = qps[qps.length - 1];

const report = {
  schema: "l0-mongo-bench/v2",
  mode: "write-100m",
  startedAt,
  finishedAt,
  uriHost,
  concurrency,
  // Rescued from log: run was interrupted at ~92% (session recycled), so this is
  // the 0→92.3M write curve; no query phase ran.
  note: "RESCUED from raw log — write interrupted at ~92% before the report/query phase; curve is authentic, batch-latency percentiles unknown.",
  write100m: {
    dbName: "l0_bench_prod2_s100m",
    docs: last.docs,
    batch: 1000,
    kept: true,
    insert: {
      docs: last.docs,
      batch: 1000,
      concurrency,
      wallMs: last.t - t0 + firstInterval,
      docsPerSec: last.avg,
      batchesPerSec: Number((last.avg / 1000).toFixed(3)),
      errors,
      batchLatency: { p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, count: 0 },
      samples,
    },
    ftsVisibilityMs: canary.ftsVisibilityMs,
    canary,
    ftsUsable: canary.usable,
  },
};

const outPath = join(REPORTS, outName);
writeFileSync(outPath, JSON.stringify(report, null, 2));

// Copy the raw log next to it for provenance.
const logCopy = join(REPORTS, outName.replace(/\.json$/, ".log"));
copyFileSync(src, logCopy);

// Prepend to index.json (dedup).
const idxPath = join(REPORTS, "index.json");
let idx = [];
try {
  idx = JSON.parse(readFileSync(idxPath, "utf8"));
} catch {
  idx = [];
}
idx = [basename(outPath), ...idx.filter((n) => n !== basename(outPath))];
writeFileSync(idxPath, JSON.stringify(idx, null, 2));

console.log(`✓ wrote ${outPath}`);
console.log(`✓ copied raw log → ${logCopy}`);
console.log(`✓ updated index.json (${idx.length} entries)`);
console.log(
  `  samples=${samples.length} span=${(samples[samples.length - 1].tMs / 3600000).toFixed(1)}h` +
    ` peakInst=${Math.max(...samples.map((s) => s.intervalDocsPerSec)).toLocaleString()}/s` +
    ` finalAvg=${last.avg.toLocaleString()}/s lastDocs=${last.docs.toLocaleString()} errors=${errors}`,
);
