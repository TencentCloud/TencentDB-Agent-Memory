import type { Logger } from "../core/types.js";

export function makeStderrLogger(): Logger {
  return {
    debug: (msg) => process.stderr.write(`[tdai:debug] ${msg}\n`),
    info: (msg) => process.stderr.write(`[tdai:info]  ${msg}\n`),
    warn: (msg) => process.stderr.write(`[tdai:warn]  ${msg}\n`),
    error: (msg) => process.stderr.write(`[tdai:error] ${msg}\n`),
  };
}
