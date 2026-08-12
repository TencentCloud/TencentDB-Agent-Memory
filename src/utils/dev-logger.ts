/**
 * Dev logger: console + file sink with level gating.
 *
 * - Always writes info/warn/error to console (same as the old console logger).
 * - Always appends to `<dataDir>/logs/gateway-dev.log` (mkdir recursive).
 * - debug is emitted (file + console.debug) only when dev mode is on:
 *   env TDAI_DEV=1 (see isDevMode).
 *
 * Fire-and-forget file writes with catch — a logging failure must never
 * crash the pipeline. At 50 MB the file rotates to `.1`/`.2` (history has to
 * survive: it is what a finished run is read from).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { defaultTdaiRoot, resolveUnderRoot } from "../gateway/tdai-root.js";
import { SerialQueue } from "./serial-queue.js";
import type { Logger } from "../core/types.js";

// 50 MB: debug bursts (recall candidates etc.) can fill 5 MB in minutes;
// dev-history is meant to survive at least a few hours.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** How many rotated generations survive (`.1` … `.N`). */
const KEPT_GENERATIONS = 2;

/** Track in-flight append promises for flushLogs() (tests only). */
const pendingWrites = new Set<Promise<void>>();

export interface DevLoggerOptions {
  /** Prefix for every line, e.g. "[tdai-gateway]". */
  tag?: string;
  /** Directory for gateway-dev.log (default: `<root>/logs`, tz-07 H1). */
  logDir?: string;
  /** Full log file path — overrides logDir (default: <logDir>/gateway-dev.log). */
  logFile?: string;
  /** Emit debug lines (default: isDevMode()). */
  dev?: boolean;
  /** Rotate once the file passes this size (default: 50 MB). */
  maxBytes?: number;
}

/** Dev mode is enabled via the TDAI_DEV=1 environment variable. */
export function isDevMode(): boolean {
  return process.env.TDAI_DEV === "1";
}

/** Resolve the log file path, honoring a tilde prefix. */
export function resolveLogFile(logDir?: string, logFile?: string): string {
  if (logFile) {
    return logFile.startsWith("~")
      ? path.join(os.homedir(), logFile.slice(2))
      : logFile;
  }
  // tz-07 H1: no legacy fallback for logs on purpose — logs are WRITTEN, and
  // the fallback is read-only. Old logs stay where they are.
  const dir = logDir ?? resolveUnderRoot(defaultTdaiRoot(), "logs");
  const expanded = dir.startsWith("~")
    ? path.join(os.homedir(), dir.slice(2))
    : dir;
  return path.join(expanded, "gateway-dev.log");
}

/**
 * Rotate `file` → `.1` → `.2`, dropping the oldest. The previous behaviour
 * truncated the log to zero, so the history a run needed was gone the moment
 * the file crossed the threshold — and it crossed it on a busy day.
 */
async function rotate(file: string): Promise<void> {
  for (let i = KEPT_GENERATIONS; i >= 1; i--) {
    const older = `${file}.${i}`;
    const newer = i === 1 ? file : `${file}.${i - 1}`;
    try {
      if (i === KEPT_GENERATIONS) await fs.promises.rm(older, { force: true });
      await fs.promises.rename(newer, older);
    } catch {
      // A generation that does not exist yet is not an error.
    }
  }
}

/** One queue per log file: appends AND rotation run serially, so two
 * concurrent writers cannot both see `size > MAX` and rename twice (that
 * loses `.1`). */
const queues = new Map<string, SerialQueue>();

function queueFor(file: string): SerialQueue {
  let q = queues.get(file);
  if (!q) {
    q = new SerialQueue(`dev-log:${path.basename(file)}`);
    queues.set(file, q);
  }
  return q;
}

async function appendLine(
  file: string,
  line: string,
  maxBytes: number,
): Promise<void> {
  const p = queueFor(file).add(async () => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      try {
        size = (await fs.promises.stat(file)).size;
      } catch {
        // file does not exist yet — start fresh
      }
      if (size > maxBytes) await rotate(file);
      await fs.promises.appendFile(file, `${line}\n`);
    } catch {
      // Logging must never crash the pipeline.
    }
  });
  pendingWrites.add(p);
  void p.finally(() => pendingWrites.delete(p));
  return p;
}

/** Await all in-flight log writes (used by tests; no-op in production). */
export async function flushLogs(): Promise<void> {
  await Promise.all([...pendingWrites]);
}

/**
 * Create a Logger that mirrors console output and appends to the dev log file.
 */
export function createDevLogger(opts: DevLoggerOptions = {}): Logger {
  const { tag = "", dev = isDevMode(), maxBytes = MAX_FILE_BYTES } = opts;
  const file = resolveLogFile(opts.logDir, opts.logFile);

  const emit = (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    msg: string,
  ): void => {
    const line = `${new Date().toISOString()} ${tag} [${level}] ${msg}`;
    // Fire-and-forget: never block the event loop on file IO.
    void appendLine(file, line, maxBytes);
  };

  return {
    debug: dev
      ? (msg: string) => {
          emit("DEBUG", msg);
          console.debug(`${tag} ${msg}`);
        }
      : undefined,
    info: (msg: string) => {
      emit("INFO", msg);
      console.info(`${tag} ${msg}`);
    },
    warn: (msg: string) => {
      emit("WARN", msg);
      console.warn(`${tag} ${msg}`);
    },
    error: (msg: string) => {
      emit("ERROR", msg);
      console.error(`${tag} ${msg}`);
    },
  };
}
