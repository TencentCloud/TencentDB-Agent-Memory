/**
 * Post-run report artifacts (wave tdai-memory-subagents-2026-08-02, P10).
 *
 * Two files, written by the orchestrator after every non-dry consolidation run:
 *
 *   1. `dataDir/memory_health.md`            — dashboard (#15): L1 by type,
 *      duplicate clusters, scene sizes, vec-vs-meta lag, precision@k, last runs.
 *   2. `dataDir/.metadata/last-digest.json`  — digest (#13): run outcome that
 *      the pi extension injects as `<memory-digest>` (opt-in TDAI_MEMORY_DIGEST=1).
 *
 * Both are fail-open: a failing sub-part renders as a "n/a" section — the run
 * itself is never marked failed because a report could not be produced.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../core/types.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { openReadonlySqlite } from "./http-utils.js";
import {
  findDuplicateClusters,
  collectBlockStats,
  checkVecMetaCounts,
} from "./memory-routes.js";
import type { ProbeResult } from "./probe.js";

// ============================
// Digest (#13)
// ============================

/** Contract of dataDir/.metadata/last-digest.json (gateway writer ↔ pi reader). */
export interface DigestData {
  runAt: string;
  status: string;
  /** Duplicate records merged/deleted by the run (applied.deletes + merges). */
  mergedDuplicates: number;
  /** Scene/persona files rewritten by the run. */
  rewrittenScenes: number;
  /** Probe precision@k (null when the probe was skipped/unavailable). */
  precisionAtK: number | null;
  elapsedMs: number;
  newL0: number;
  recordsPresented: number;
  error?: string;
}

export const DIGEST_FILENAME = "last-digest.json";

/** Resolve the digest file path (`.metadata` under dataDir). */
export function digestPath(dataDir: string): string {
  return path.join(dataDir, ".metadata", DIGEST_FILENAME);
}

/** Write the digest atomically (tmp + rename). Never throws for the caller. */
export function writeDigest(
  dataDir: string,
  digest: DigestData,
  logger?: Logger,
): void {
  try {
    const file = digestPath(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(digest, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    logger?.warn?.(
      `[memory] digest write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read + parse the digest (null on missing/malformed). */
export function readDigest(dataDir: string): DigestData | null {
  try {
    const raw = fs.readFileSync(digestPath(dataDir), "utf-8");
    const parsed = JSON.parse(raw) as DigestData;
    if (!parsed || typeof parsed.runAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ============================
// Dashboard (#15) — dataDir/memory_health.md
// ============================

export interface DashboardInput {
  dataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  /** Probe result from the same run (precision@k section). */
  probe?: ProbeResult | null;
}

/** One L1-by-type bucket. */
export interface L1TypeCount {
  type: string;
  count: number;
}

/** Query l1_records GROUP BY type (readonly; [] on failure). */
export function countL1ByType(dataDir: string, logger?: Logger): L1TypeCount[] {
  try {
    const db = openReadonlySqlite(path.join(dataDir, "vectors.db"));
    try {
      const rows = db
        .prepare(
          "SELECT COALESCE(type, '') AS type, COUNT(*) AS c FROM l1_records GROUP BY type ORDER BY c DESC",
        )
        .all() as Array<{ type: string; c: number }>;
      return rows.map((r) => ({
        type: String(r.type ?? ""),
        count: Number(r.c) || 0,
      }));
    } finally {
      db.close();
    }
  } catch (err) {
    logger?.warn?.(
      `[memory] dashboard L1-by-type query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Last N run reports from dataDir/logs/<role>-*.json (newest last). */
export function readLastRuns(
  dataDir: string,
  n: number,
): Array<Record<string, unknown>> {
  const logsDir = path.join(dataDir, "logs");
  let files: string[];
  try {
    // Reports are named `<role>-<ISO ts>.json`, so a plain name sort orders by
    // ROLE first and only then by time: with many `memory-keeper-*` files a
    // lexicographically smaller role prefix could never reach the last N.
    // Sort by the timestamp in the name (the ISO form is monotonic as text);
    // a name without one sorts last, by name.
    const tsOf = (f: string): string =>
      /-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/.exec(f)?.[1] ?? "";
    files = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith(".json"))
      .sort((a, b) => {
        const ta = tsOf(a);
        const tb = tsOf(b);
        if (ta === tb) return a.localeCompare(b);
        if (ta === "") return 1;
        if (tb === "") return -1;
        return ta.localeCompare(tb);
      });
  } catch {
    return [];
  }
  const last = files.slice(-n);
  const runs: Array<Record<string, unknown>> = [];
  for (const f of last) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(logsDir, f), "utf-8"),
      ) as Record<string, unknown>;
      runs.push({
        file: f,
        role: parsed.role ?? "",
        status: parsed.status ?? "unknown",
        startedAt: parsed.startedAt ?? "",
        elapsedMs: parsed.elapsedMs ?? 0,
        newL0: parsed.newL0 ?? 0,
        error: parsed.error ?? undefined,
      });
    } catch {
      // Skip malformed report.
    }
  }
  return runs;
}

/** Format a probe result for the dashboard (markdown). */
function probeSection(probe: ProbeResult | null | undefined): string {
  if (!probe) return "## Precision@k\n\nno probe result for this run\n";
  const p = probe.precisionAtK;
  const t = probe.top1HitRate;
  const line =
    probe.status === "ok"
      ? `- queries: ${probe.queries}\n- topK: ${probe.topK}\n- precision@k: ${p === null ? "n/a" : (p * 100).toFixed(1) + "%"}\n- top-1 hit rate: ${t === null ? "n/a" : (t * 100).toFixed(1) + "%"}`
      : `- status: ${probe.status}${probe.reason ? ` (${probe.reason})` : ""}`;
  return `## Precision@k\n\n${line}\n`;
}

/**
 * Build the memory_health.md markdown. Every data source is fail-open — a
 * failed sub-read yields an explicit "n/a" note, never a throw.
 * `clustersSummary` is precomputed by writeDashboard (async, may need
 * vector+embedding resources); here it is just text.
 */
export function buildDashboardMarkdown(
  input: DashboardInput & { clustersSummary?: string },
): string {
  const { dataDir, logger, probe, clustersSummary } = input;
  const lines: string[] = [
    "# Memory health",
    "",
    `> Auto-generated by the TDAI memory gateway after a consolidation run (${new Date().toISOString()}).`,
    "",
    "## L1 by type",
    "",
  ];

  const byType = countL1ByType(dataDir, logger);
  if (byType.length === 0) {
    lines.push("n/a (no l1_records or query failed)", "");
  } else {
    for (const t of byType)
      lines.push(`- **${t.type || "(empty)"}**: ${t.count}`);
    lines.push("");
  }

  lines.push("## Duplicate clusters", "", clustersSummary ?? "n/a", "");

  lines.push("## Scene sizes", "");
  const { blocks, overLimit } = collectBlockStats(dataDir);
  if (blocks.length === 0) {
    lines.push("n/a (no scene blocks / persona)", "");
  } else {
    for (const b of blocks) {
      lines.push(
        `- ${b.path}: ${b.size}/${b.limit} chars${b.over ? " **OVER LIMIT**" : ""}`,
      );
    }
    if (overLimit.length === 0) lines.push("", "All files within limits.");
    lines.push("");
  }

  lines.push("## vec-vs-meta", "");
  const vecMeta = checkVecMetaCounts(dataDir);
  lines.push(
    vecMeta.consistent === null
      ? `- n/a (${vecMeta.note ?? "vec0 unavailable"})`
      : `- meta=${vecMeta.metaCount}, vec=${vecMeta.vecCount}, consistent=${vecMeta.consistent ? "yes" : "NO"}`,
    "",
  );

  lines.push(probeSection(probe));

  lines.push("## Last runs", "");
  const runs = readLastRuns(dataDir, 5);
  if (runs.length === 0) {
    lines.push("n/a (no run reports yet)", "");
  } else {
    for (const r of runs) {
      lines.push(
        `- ${String(r.startedAt ?? "")} [${String(r.status ?? "")}] ` +
          `role=${String(r.role ?? "")}, ` +
          `newL0=${String(r.newL0 ?? 0)}, elapsed=${String(r.elapsedMs ?? 0)}ms` +
          (r.error ? `, error: ${String(r.error)}` : ""),
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Write the dashboard file (memory_health.md) atomically. Fail-open: never
 * throws — the run continues even if the dashboard cannot be written.
 */
export async function writeDashboard(
  input: DashboardInput,
): Promise<string | null> {
  const { dataDir, logger, vectorStore, embeddingService, probe } = input;

  // Duplicate clusters need vector+embedding; compute them only when available
  // (bounded to the last 100 records so the nightly dashboard stays cheap).
  let clustersLine = "n/a (vector store / embedding unavailable)";
  if (vectorStore && embeddingService) {
    try {
      const found = await findDuplicateClusters(
        {
          store: vectorStore,
          embed: embeddingService,
          dataDir,
          logger: logger ?? silentLogger(),
        },
        { topK: 5, threshold: 0.8, limit: 100 },
      );
      if (found.degraded) {
        clustersLine = `degraded (${found.reason ?? "resources unavailable"})`;
      } else if (found.clusters.length === 0) {
        clustersLine = "no duplicate clusters found in the recent window";
      } else {
        const totalMembers = found.clusters.reduce(
          (s, c) => s + c.similar.length,
          0,
        );
        clustersLine = `${found.clusters.length} cluster(s), ${totalMembers} duplicate member(s)`;
      }
    } catch (err) {
      logger?.warn?.(
        `[memory] dashboard cluster scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      clustersLine = "cluster scan failed";
    }
  }

  let markdown = buildDashboardMarkdown({
    ...input,
    clustersSummary: clustersLine,
  });

  try {
    const file = path.join(dataDir, "memory_health.md");
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, markdown, "utf-8");
    fs.renameSync(tmp, file);
    return file;
  } catch (err) {
    logger?.warn?.(
      `[memory] dashboard write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
