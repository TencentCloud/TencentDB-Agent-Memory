/**
 * Logger — simple leveled logging module
 */

import dayjs from "dayjs";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = (process.env.LOG_LEVEL || "debug") as Level;

function ts() {
  // Local time with explicit UTC offset, consistent with MemoryCore's
  // nowLocalIso() (see MemoryCore/src/gateway/server.ts): the wall-clock
  // matches what the operator sees in tmux / tail -f while the line stays
  // ISO 8601 compliant and round-trippable. Previously this was UTC with no
  // timezone marker, which made cross-service incident correlation error-prone.
  return dayjs().format("YYYY-MM-DDTHH:mm:ss.SSSZ");
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
    debug(msg: string, data?: unknown) {
      if (shouldLog("debug")) console.log(format("debug", tag, msg, data));
    },
    info(msg: string, data?: unknown) {
      if (shouldLog("info")) console.log(format("info", tag, msg, data));
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
