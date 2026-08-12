/**
 * Run reports: write the per-role report to dataDir/logs/ and read the
 * newest one back on startup.
 *
 * Split from runner.ts to keep that file ≤150 lines.
 */

import fs from "node:fs";
import path from "node:path";
import { runPostRunSteps } from "./runner-helpers.js";
import { updateRun } from "../control-plane/run-repo.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";

/**
 * Record the report path on the Run row, so "what happened in run X" starts
 * from the control plane instead of a guess. Fail-open: a dry run has no Run
 * row (updateRun returns false) and a broken control plane must not take the
 * report down with it.
 */
function linkReportToRun(
  ctx: OrchestratorContext,
  summary: RunSummary,
  file: string,
): void {
  if (summary.runId === undefined || summary.dryRun) return;
  try {
    updateRun(
      ctx.dataDir,
      summary.runId,
      { logPath: file },
      new Date(ctx.now()).toISOString(),
    );
  } catch (err) {
    ctx.logger.warn?.(
      `[run] report link failed for ${summary.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Write dataDir/logs/<role>-<ts>[-<runId8>].json (+ optional .diff.md). */
export async function writeReport(
  ctx: OrchestratorContext,
  summary: RunSummary,
  diffText?: string,
): Promise<string> {
  const finishedMs = ctx.now();
  summary.finishedAt = new Date(finishedMs).toISOString();
  summary.elapsedMs = Math.max(0, finishedMs - Date.parse(summary.startedAt));

  // P10 post-run extras for REAL (non-dry) runs: recall-quality probe (#1),
  // dashboard memory_health.md (#15), digest .metadata/last-digest.json (#13).
  // Fail-open: extras failures are logged, never propagated to the run.
  if (!summary.dryRun) {
    try {
      await runPostRunSteps(ctx, summary);
    } catch (err) {
      ctx.logger.warn?.(
        `[memory-keeper] post-run extras failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const logsDir = path.join(ctx.dataDir, "logs");
  await fs.promises.mkdir(logsDir, { recursive: true });
  const ts = summary.startedAt.replace(/[:.]/g, "-");
  // The run id goes into the NAME (and stays flat under logs/): a report is
  // then reachable from a control-plane row and back, while cleanup.ts, which
  // only ages top-level entries, keeps working.
  const stem = `${summary.role}-${ts}${
    summary.runId ? `-${summary.runId.slice(0, 8)}` : ""
  }`;
  const file = path.join(logsDir, `${stem}.json`);
  await fs.promises.writeFile(file, JSON.stringify(summary, null, 2), "utf-8");
  if (diffText !== undefined) {
    await fs.promises.writeFile(
      path.join(logsDir, `${stem}.diff.md`),
      diffText,
      "utf-8",
    );
  }
  linkReportToRun(ctx, summary, file);
  ctx.lastRunRef.value = summary;
  ctx.logger.info?.(
    `[memory-keeper] run ${summary.status} (${summary.reason}): newL0=${summary.newL0}, ` +
      `records=${summary.recordsPresented}, merges=${summary.applied.merges.length}, ` +
      `rewrites=${summary.applied.rewrites.length}${summary.error ? `, error: ${summary.error}` : ""}`,
  );
  return file;
}

/** Resume the last run summary from logs/<role>-*.json across ALL roles
 * (day keeper + night-keeper share the logs dir). */
export async function readLastReport(
  ctx: OrchestratorContext,
): Promise<RunSummary | null> {
  const logsDir = path.join(ctx.dataDir, "logs");
  let files: string[];
  try {
    files = (await fs.promises.readdir(logsDir)).filter((f) =>
      f.endsWith(".json"),
    );
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  // Pick the NEWEST report by startedAt from the JSON BODY — the filename
  // ts is Date.parse-NaN (dashed ISO) and lexicographic sort puts
  // memory-keeper-* before night-keeper-*. A corrupt JSON file is SKIPPED.
  let newest: RunSummary | null = null;
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(path.join(logsDir, file), "utf-8"),
      ) as RunSummary;
      if (
        typeof parsed.startedAt !== "string" ||
        Number.isNaN(Date.parse(parsed.startedAt))
      ) {
        continue;
      }
      if (
        newest === null ||
        Date.parse(parsed.startedAt) > Date.parse(newest.startedAt)
      ) {
        newest = parsed;
      }
    } catch {
      // corrupt JSON → skip; never hide the freshest valid report
    }
  }
  return newest;
}
