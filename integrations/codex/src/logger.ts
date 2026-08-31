import type { AdapterLogger } from "./types.js";

function write(level: string, message: string): void {
  process.stderr.write(`[memory-tencentdb-codex] ${level} ${message}\n`);
}

export const stderrLogger: AdapterLogger = {
  debug: (message) => write("DEBUG", message),
  info: (message) => write("INFO", message),
  warn: (message) => write("WARN", message),
  error: (message) => write("ERROR", message),
};
