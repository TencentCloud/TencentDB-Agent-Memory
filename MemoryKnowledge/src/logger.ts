/**
 * Logger — simple leveled logging module
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || "debug") as Level;

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function shouldLog(level: Level) {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[LOG_LEVEL];
}

function format(level: Level, tag: string, msg: string, data?: unknown) {
  const prefix = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  if (data !== undefined) {
    return `${prefix} ${msg} ${JSON.stringify(data, null, 0)}`;
  }
  return `${prefix} ${msg}`;
}

export function createLogger(tag: string) {
  return {
    // All log levels go to stderr: the MCP stdio transport reads the protocol
    // from stdout, so any diagnostic line written there would corrupt the
    // JSON-RPC stream (see issue #766).
    debug(msg: string, data?: unknown) {
      if (shouldLog("debug")) process.stderr.write(format("debug", tag, msg, data) + "\n");
    },
    info(msg: string, data?: unknown) {
      if (shouldLog("info")) process.stderr.write(format("info", tag, msg, data) + "\n");
    },
    warn(msg: string, data?: unknown) {
      if (shouldLog("warn")) console.warn(format("warn", tag, msg, data));
    },
    error(msg: string, data?: unknown) {
      if (shouldLog("error")) console.error(format("error", tag, msg, data));
    },
  };
}

export const log = createLogger("app");
