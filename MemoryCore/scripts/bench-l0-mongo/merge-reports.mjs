/**
 * Stitch an interrupted write and its --resume continuation into one report.
 *
 * The 100M load ran in two sessions (the first was killed at ~92%), so neither
 * report alone shows the full 0→100M curve. This concatenates them along
 * *cumulative write time* (the idle gap between sessions is not write time and
 * is dropped), recomputes the global cumulative rate, and keeps the second
 * run's query results so one file carries the whole story.
 *
 * Usage: node merge-reports.mjs <first.json> <second.json> <out-name.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(__dirname, "reports");

const [, , aName, bName, outName = "l0-bench-100M-merged.json"] = process.argv;
const load = (n) => JSON.parse(readFileSync(join(REPORTS, basename(n)), "utf8"));
const a = load(aName);
const b = load(bName);

const aS = a.write100m.insert.samples;
const bS = b.write100m.insert.samples;
const aEnd = aS[aS.length - 1].tMs;

// A sample's `docs` is the count written by ITS run (the resume run only prints
// absolute progress; it still stores run-relative counts), so session 2 needs
// the pre-existing doc count added as well as the time shift. That offset is
// exactly target − what this run inserted.
const bOffset = b.write100m.docs - b.write100m.insert.docs;
const merged = [
  ...aS,
  ...bS.map((s) => ({ ...s, tMs: s.tMs + aEnd, docs: s.docs + bOffset })),
].map((s) => ({
  ...s,
  cumulativeDocsPerSec: Number((s.docs / (s.tMs / 1000)).toFixed(2)),
}));

const last = merged[merged.length - 1];
const totalWallMs = last.tMs;

const out = {
  schema: "l0-mongo-bench/v2",
  mode: "write-100m",
  startedAt: a.startedAt,
  finishedAt: b.finishedAt,
  uriHost: b.uriHost,
  concurrency: b.concurrency,
  note:
    "MERGED: session 1 (0→92.3M, interrupted at 92%) + session 2 (--resume, 92.3M→100M)." +
    " X axis is cumulative write time; the idle gap between sessions is excluded." +
    " Batch-latency percentiles are from session 2 (session 1's were lost with its report).",
  write100m: {
    dbName: b.write100m.dbName,
    docs: last.docs,
    batch: b.write100m.batch,
    kept: true,
    insert: {
      docs: last.docs,
      batch: b.write100m.batch,
      concurrency: b.concurrency,
      wallMs: totalWallMs,
      docsPerSec: Number((last.docs / (totalWallMs / 1000)).toFixed(2)),
      batchesPerSec: Number((last.docs / b.write100m.batch / (totalWallMs / 1000)).toFixed(3)),
      errors: (a.write100m.insert.errors ?? 0) + (b.write100m.insert.errors ?? 0),
      batchLatency: b.write100m.insert.batchLatency,
      samples: merged,
    },
    ftsVisibilityMs: b.write100m.ftsVisibilityMs,
    canary: a.write100m.canary,
    ftsUsable: b.write100m.ftsUsable,
  },
  query: b.query,
};

writeFileSync(join(REPORTS, outName), JSON.stringify(out, null, 2));

const idxPath = join(REPORTS, "index.json");
let idx = [];
try {
  idx = JSON.parse(readFileSync(idxPath, "utf8"));
} catch {
  idx = [];
}
idx = [outName, ...idx.filter((n) => n !== outName)];
writeFileSync(idxPath, JSON.stringify(idx, null, 2));

console.log(`✓ merged → reports/${outName}`);
console.log(
  `  samples=${merged.length} (${aS.length}+${bS.length}) totalWrite=${(totalWallMs / 3600000).toFixed(1)}h` +
    ` docs=${last.docs.toLocaleString()} overallAvg=${out.write100m.insert.docsPerSec}/s` +
    ` peakInst=${Math.max(...merged.map((s) => s.intervalDocsPerSec)).toLocaleString()}/s errors=${out.write100m.insert.errors}`,
);
