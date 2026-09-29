import dayjs from "dayjs";
import type { Logger } from "../core/types.js";
import {
  resolveConsoleLogLevel,
  type ConsoleLogLevel,
} from "../utils/env-config.js";

const LEVEL_PRIORITY: Record<ConsoleLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function nowLocalIso(): string {
  return dayjs().format("YYYY-MM-DDTHH:mm:ss.SSSZ");
}

/** Create the leveled console logger used by the standalone gateway. */
export function createConsoleLogger(tag: string): Logger {
  const minimumLevel = resolveConsoleLogLevel();
  const shouldLog = (level: ConsoleLogLevel): boolean =>
    LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minimumLevel];

  return {
    debug: (msg: string) => {
      if (shouldLog("debug")) console.debug(`${nowLocalIso()} DEBUG ${tag} ${msg}`);
    },
    info: (msg: string) => {
      if (shouldLog("info")) console.info(`${nowLocalIso()} INFO  ${tag} ${msg}`);
    },
    warn: (msg: string) => {
      if (shouldLog("warn")) console.warn(`${nowLocalIso()} WARN  ${tag} ${msg}`);
    },
    error: (msg: string) => {
      if (shouldLog("error")) console.error(`${nowLocalIso()} ERROR ${tag} ${msg}`);
    },
  };
}
