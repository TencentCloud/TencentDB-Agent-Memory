/**
 * `tdai-run-log` — everything known about one run, in one command.
 *
 * Before this, checking a run meant opening control-plane.db by hand and
 * grepping a 27 MB gateway-dev.log without knowing which lines belonged to
 * the run. Three sources, one output:
 *   1. the control-plane row (state, failure class, fence, lease, report path);
 *   2. the run report the row points at (status, error, applied ops, and the
 *      child's stderr — which is where a provider refusal actually shows up);
 *   3. the gateway log lines tagged with this run.
 *
 * Read-only, and works while the gateway is down: sqlite is opened readonly
 * and the rest is plain files.
 *
 * Usage:
 *   npx tsx scripts/tdai-run-log.mts <runId|last> [--tail N] [--data-dir DIR]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openReadonlySqlite } from "../src/gateway/http-utils.js";
import { runTag } from "../src/utils/logger-tag.js";

interface Args {
  target: string;
  tail: number;
  dataDir: string;
}

const DEFAULT_TAIL = 40;

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let tail = DEFAULT_TAIL;
  let dataDir = path.join(os.homedir(), ".pi", "agent-memory", "tdai");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tail") tail = Number(argv[++i] ?? DEFAULT_TAIL);
    else if (arg === "--data-dir") dataDir = argv[++i] ?? dataDir;
    else rest.push(arg);
  }
  if (rest.length === 0) {
    throw new Error(
      "usage: tdai-run-log.mts <runId|last> [--tail N] [--data-dir DIR]",
    );
  }
  return { target: rest[0]!, tail, dataDir };
}

interface RunRow {
  runId: string;
  roleId: string;
  state: string;
  fence: number;
  errorClass: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  reason: string | null;
  createdAt: string;
  finishedAt: string | null;
  logPath: string;
  scratchPath: string;
}

/** The run row: the exact id, a unique prefix, or the newest one. */
function findRun(dataDir: string, target: string): RunRow | null {
  const dbPath = path.join(dataDir, ".metadata", "control-plane.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`нет control-plane: ${dbPath} (проверь --data-dir)`);
  }
  const db = openReadonlySqlite(dbPath);
  try {
    const cols =
      "runId, roleId, state, fence, errorClass, leaseOwner, leaseExpiresAt, " +
      "reason, createdAt, finishedAt, logPath, scratchPath";
    const rows =
      target === "last"
        ? db
            .prepare(`SELECT ${cols} FROM runs ORDER BY createdAt DESC LIMIT 1`)
            .all()
        : db
            .prepare(
              `SELECT ${cols} FROM runs WHERE runId = ? OR runId LIKE ? ` +
                "ORDER BY createdAt DESC LIMIT 1",
            )
            .all(target, `${target}%`);
    return (rows[0] as RunRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

/** Report next to the row. A run that died before its report has none. */
function readReport(
  row: RunRow,
  dataDir: string,
): Record<string, unknown> | null {
  const candidates = [row.logPath].filter((p) => p !== "");
  // Reports written before the link existed are found by the id in the name.
  if (candidates.length === 0) {
    const logsDir = path.join(dataDir, "logs");
    try {
      const short = row.runId.slice(0, 8);
      for (const f of fs.readdirSync(logsDir)) {
        if (f.endsWith(`-${short}.json`))
          candidates.push(path.join(logsDir, f));
      }
    } catch {
      // no logs dir yet
    }
  }
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      // unreadable / not written yet → fall through to the next candidate
    }
  }
  return null;
}

/** Tagged lines from the gateway log and its rotated generations. */
function readTaggedLines(
  dataDir: string,
  runId: string,
  tail: number,
): string[] {
  const base = path.join(dataDir, "logs", "gateway-dev.log");
  const tag = runTag(runId);
  const out: string[] = [];
  // Oldest generation first, so the tail is chronological.
  for (const file of [`${base}.2`, `${base}.1`, base]) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.includes(tag)) out.push(line);
    }
  }
  return out.slice(-tail);
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function printReport(report: Record<string, unknown>): void {
  const applied = (report.applied ?? {}) as Record<string, unknown>;
  const skipped = (report.skipped ?? {}) as Record<string, unknown>;
  console.log(
    `  status       : ${String(report.status)} (${String(report.reason)})` +
      `${report.dryRun === true ? " [dry-run]" : ""}`,
  );
  console.log(
    `  timing       : ${String(report.startedAt)} → ${String(report.finishedAt)}` +
      ` (${String(report.elapsedMs)} ms)`,
  );
  console.log(
    `  presented    : ${String(report.recordsPresented)} записей, newL0=${String(report.newL0)}`,
  );
  console.log(
    `  applied      : merges=${count(applied.merges)} deletes=${count(applied.deletes)} ` +
      `rewrites=${count(applied.rewrites)}`,
  );
  console.log(
    `  skipped      : merges=${count(skipped.merges)} deletes=${count(skipped.deletes)} ` +
      `rewrites=${count(skipped.rewrites)}`,
  );
  if (report.error !== undefined)
    console.log(`  error        : ${String(report.error)}`);
  const child = report.child as
    { exitCode?: number; timedOut?: boolean; stderr?: string } | undefined;
  if (child) {
    console.log(
      `  child        : exit=${String(child.exitCode)} timedOut=${String(child.timedOut)}`,
    );
    const stderr = (child.stderr ?? "").trim();
    if (stderr !== "") {
      console.log("  child stderr :");
      for (const line of stderr.split("\n").slice(-10)) {
        console.log(`    ${line}`);
      }
    }
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const row = findRun(args.dataDir, args.target);
  if (row === null) {
    console.error(`прогон не найден: ${args.target} (dataDir=${args.dataDir})`);
    return 1;
  }

  console.log(`=== ПРОГОН ${row.runId}`);
  console.log(`  роль         : ${row.roleId}`);
  console.log(
    `  состояние    : ${row.state}${row.errorClass ? ` / ${row.errorClass}` : ""}`,
  );
  console.log(`  причина      : ${row.reason ?? "-"}`);
  console.log(
    `  время        : ${row.createdAt} → ${row.finishedAt ?? "(не закончен)"}`,
  );
  console.log(
    `  fence/аренда : ${row.fence} / ${row.leaseOwner ?? "-"} до ${row.leaseExpiresAt ?? "-"}`,
  );
  console.log(
    `  отчёт        : ${row.logPath === "" ? "(не записан)" : row.logPath}`,
  );
  console.log(`  scratch      : ${row.scratchPath}`);

  console.log("=== ОТЧЁТ");
  const report = readReport(row, args.dataDir);
  if (report === null)
    console.log("  (отчёта нет — прогон не дошёл до записи)");
  else printReport(report);

  console.log(`=== ЛОГ (${runTag(row.runId)}, последние ${args.tail})`);
  const lines = readTaggedLines(args.dataDir, row.runId, args.tail);
  if (lines.length === 0) console.log("  (теговых строк нет)");
  else for (const line of lines) console.log(`  ${line}`);
  return 0;
}

// Catch-all at the entry: a diagnostic tool must SAY what is wrong (missing
// control plane, wrong --data-dir, no argument), not hand back a raw stack.
try {
  process.exitCode = main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
