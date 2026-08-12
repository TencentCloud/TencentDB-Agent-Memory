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
import { loadGatewayConfig } from "../src/gateway/config.js";
import { resolveLogFile } from "../src/utils/dev-logger.js";

interface Args {
  target: string;
  tail: number;
  dataDir: string;
  /** Base log file; `.1`/`.2` are read next to it. */
  logFile: string;
}

const DEFAULT_TAIL = 40;

function parseArgs(argv: string[]): Args {
  const rest: string[] = [];
  let tail = DEFAULT_TAIL;
  let dataDir = path.join(os.homedir(), ".pi", "agent-memory", "tdai");
  let logFile = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tail") {
      const raw = argv[++i] ?? "";
      tail = Number(raw);
      if (!Number.isInteger(tail) || tail <= 0) {
        throw new Error(`--tail ждёт положительное целое, а получил "${raw}"`);
      }
    } else if (arg === "--data-dir") dataDir = argv[++i] ?? dataDir;
    else if (arg === "--log-file") logFile = argv[++i] ?? logFile;
    else rest.push(arg);
  }
  if (rest.length === 0) {
    throw new Error(
      "usage: tdai-run-log.mts <runId|last> [--tail N] [--data-dir DIR] " +
        "[--log-file FILE]",
    );
  }
  return {
    target: rest[0]!,
    tail,
    dataDir,
    logFile: logFile || logFileFor(dataDir),
  };
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

/**
 * Where the gateway actually writes: `logging.file` in the gateway config
 * wins over the dataDir default, exactly as in dev-logger — a tool that
 * scans the wrong file reports "no lines" and sends the reader guessing
 * again.
 */
function logFileFor(dataDir: string): string {
  try {
    const cfg = loadGatewayConfig();
    if (cfg.logging.file) return resolveLogFile(undefined, cfg.logging.file);
  } catch {
    // No readable config → the dataDir default below.
  }
  return path.join(dataDir, "logs", "gateway-dev.log");
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

/**
 * The run's report. `logPath` is the fast path, but the logs dir is scanned
 * for `-<runId8>.json` ALWAYS: a report written before the link existed — or
 * a row whose logPath points at a file that has since been cleaned away —
 * would otherwise be reported as missing while it sits on disk.
 */
function readReport(
  runId: string,
  logPath: string,
  dataDir: string,
): { report: Record<string, unknown> | null; tried: string[] } {
  const candidates = logPath === "" ? [] : [logPath];
  const logsDir = path.join(dataDir, "logs");
  try {
    const short = runId.slice(0, 8);
    for (const f of fs.readdirSync(logsDir).sort()) {
      const full = path.join(logsDir, f);
      if (f.endsWith(`-${short}.json`) && !candidates.includes(full)) {
        candidates.push(full);
      }
    }
  } catch {
    // no logs dir yet
  }
  for (const file of candidates) {
    try {
      return {
        report: JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
          string,
          unknown
        >,
        tried: candidates,
      };
    } catch {
      // unreadable / half-written → try the next candidate
    }
  }
  return { report: null, tried: candidates };
}

/** Tagged lines from the gateway log and its rotated generations. */
function readTaggedLines(base: string, runId: string, tail: number): string[] {
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

/** Отчёт + теговые строки: всё, что читается по одному только id. */
function printByRunId(runId: string, args: Args, row: RunRow | null): void {
  console.log("=== ОТЧЁТ");
  const { report, tried } = readReport(runId, row?.logPath ?? "", args.dataDir);
  if (report !== null) printReport(report);
  else if (tried.length === 0) {
    console.log("  (отчёта нет — прогон не дошёл до записи)");
  } else {
    console.log(`  (отчёт не читается: ${tried.join(", ")})`);
  }

  console.log(`=== ЛОГ (${runTag(runId)}, последние ${args.tail})`);
  const lines = readTaggedLines(args.logFile, runId, args.tail);
  if (lines.length === 0) {
    console.log(`  (теговых строк нет; смотрел ${args.logFile}[.1][.2])`);
  } else for (const line of lines) console.log(`  ${line}`);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const row = findRun(args.dataDir, args.target);
  if (row === null) {
    // Строки может не быть — прогон старше control-plane или его вымела
    // ретенция. Отчёт и лог всё ещё адресуются по id, и это ровно тот
    // случай, ради которого инструмент писался.
    if (args.target === "last") {
      console.error(`в control-plane нет ни одного прогона (${args.dataDir})`);
      return 1;
    }
    console.log(`=== ПРОГОН ${args.target} (строки в control-plane нет)`);
    printByRunId(args.target, args, null);
    return 0;
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

  printByRunId(row.runId, args, row);
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
