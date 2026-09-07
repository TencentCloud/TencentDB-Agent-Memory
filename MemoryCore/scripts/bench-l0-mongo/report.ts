/**
 * Self-describing JSON report writer. One file per run under `reports/`
 * (gitignored). `view-report.html` reads exactly this shape.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InsertResult } from "./insert.js";
import type { QueryReport } from "./query.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPORTS_DIR = join(HERE, "reports");

export interface BenchReport {
  schema: "l0-mongo-bench/v2";
  mode: string;
  startedAt: string;
  finishedAt: string;
  uriHost: string;
  concurrency: number;
  /**
   * Write concern the benchmarked inserts ran under. `majority` waits on a
   * secondary and is therefore exposed to replication-lag stalls; `1` is not.
   * Recorded so two runs are never compared without knowing which rule applied.
   */
  writeConcern?: "majority" | "1";
  write1m?: {
    dbName: string;
    docsPerTier: number;
    dropped: boolean;
    byBatch: Record<string, InsertResult>;
  };
  write100m?: {
    dbName: string;
    docs: number;
    batch: number;
    kept: boolean;
    insert: InsertResult;
    ftsVisibilityMs: number;
    /** Canary gate: verify $search works on a small seed before the full write. */
    canary?: {
      docs: number;
      /** ms until BM25 returned a hit on the canary seed, or -1 if it never did. */
      ftsVisibilityMs: number;
      /** Hit count from the canary probe. */
      hits: number;
      usable: boolean;
      /** ms of post-data polling until $search became queryable. */
      indexReadyPollMs?: number;
      /** ms from index creation (store.init) until $search became queryable. */
      indexReadySinceInitMs?: number;
    };
    /** Whether $search was usable for this run (drives query-phase interpretation). */
    ftsUsable?: boolean;
  };
  query?: QueryReport;
}

export function writeReport(report: BenchReport): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const path = join(REPORTS_DIR, `l0-bench-${stamp}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  writeIndex();
  return path;
}

/** Refresh reports/index.json (newest first) so view-report.html can list them over HTTP. */
export function writeIndex(): void {
  const files = readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith("l0-bench-") && f.endsWith(".json"))
    .sort()
    .reverse();
  writeFileSync(join(REPORTS_DIR, "index.json"), JSON.stringify(files, null, 2), "utf8");
}
