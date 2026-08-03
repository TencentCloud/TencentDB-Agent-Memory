/**
 * Dev logger: console + file sink with level gating.
 *
 * - Always writes info/warn/error to console (same as the old console logger).
 * - Always appends to `<dataDir>/logs/gateway-dev.log` (mkdir recursive).
 * - debug is emitted (file + console.debug) only when dev mode is on:
 *   env TDAI_DEV=1 (see isDevMode).
 *
 * Fire-and-forget file writes with catch — a logging failure must never
 * crash the pipeline. File rotation is a simple truncate at 50 MB (dev log;
 * loss at the boundary is acceptable).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Logger } from "../core/types.js";

// 50 MB: debug bursts (recall candidates etc.) can fill 5 MB in minutes;
// dev-history is meant to survive at least a few hours.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Track in-flight append promises for flushLogs() (tests only). */
const pendingWrites = new Set<Promise<void>>();

export interface DevLoggerOptions {
  /** Prefix for every line, e.g. "[tdai-gateway]". */
  tag?: string;
  /** Directory for gateway-dev.log (default: ~/.pi/agent-memory/tdai/logs). */
  logDir?: string;
  /** Full log file path — overrides logDir (default: <logDir>/gateway-dev.log). */
  logFile?: string;
  /** Emit debug lines (default: isDevMode()). */
  dev?: boolean;
}

/** Dev mode is enabled via the TDAI_DEV=1 environment variable. */
export function isDevMode(): boolean {
  return process.env.TDAI_DEV === "1";
}

/** Resolve the log file path, honoring a tilde prefix. */
export function resolveLogFile(logDir?: string, logFile?: string): string {
  if (logFile) {
    return logFile.startsWith("~") ? path.join(os.homedir(), logFile.slice(2)) : logFile;
  }
  const dir = logDir ?? "~/.pi/agent-memory/tdai/logs";
  const expanded = dir.startsWith("~")
    ? path.join(os.homedir(), dir.slice(2))
    : dir;
  return path.join(expanded, "gateway-dev.log");
}

async function appendLine(file: string, line: string): Promise<void> {
  const p = (async () => {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      try {
        size = (await fs.promises.stat(file)).size;
      } catch {
        // file does not exist yet — start fresh
      }
      if (size > MAX_FILE_BYTES) {
        // Rotate: truncate to zero (keeps the file, loses history).
        await fs.promises.writeFile(file, "");
      }
      await fs.promises.appendFile(file, `${line}\n`);
    } catch {
      // Logging must never crash the pipeline.
    }
  })();
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
  const { tag = "", dev = isDevMode() } = opts;
  const file = resolveLogFile(opts.logDir, opts.logFile);

  const emit = (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    msg: string,
  ): void => {
    const line = `${new Date().toISOString()} ${tag} [${level}] ${msg}`;
    // Fire-and-forget: never block the event loop on file IO.
    void appendLine(file, line);
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
