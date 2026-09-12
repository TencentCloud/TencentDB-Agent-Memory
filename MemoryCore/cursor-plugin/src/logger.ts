/**
 * Cursor 适配器日志：在 rootDir/logs 追加脱敏事件，并按大小轮转。
 * 日志仅作本地尽力记录；失败不阻断 Hook 或 worker，敏感字段始终脱敏。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

const SENSITIVE_KEY = /(?:prompt|text|content|response|assistant|user_content)/i;

export interface CursorLoggerOptions {
  maxBytes?: number;
}

function sanitizeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (SENSITIVE_KEY.test(key)) return [key, "[redacted]"];
      if (typeof value === "string") return [key, value.slice(0, 300)];
      return [key, value];
    }),
  );
}

export function createCursorLogger(
  rootDir: string,
  options: CursorLoggerOptions = {},
): (event: string, fields?: Record<string, unknown>) => void {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const logsDir = path.join(rootDir, "logs");
  const logPath = path.join(logsDir, "cursor-hook.log");
  const rotatedPath = `${logPath}.1`;

  return (event, fields = {}) => {
    try {
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify({
        at_ms: Date.now(),
        event: event.slice(0, 100),
        ...sanitizeFields(fields),
      })}\n`;
      const currentSize = existsSync(logPath) ? statSync(logPath).size : 0;
      if (currentSize + Buffer.byteLength(line) > maxBytes) {
        if (existsSync(rotatedPath)) unlinkSync(rotatedPath);
        if (existsSync(logPath)) renameSync(logPath, rotatedPath);
      }
      appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // 日志不得阻断 Hook 或 worker。
    }
  };
}
