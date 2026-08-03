/**
 * Structured logging facade — the single entry point for all logging.
 *
 * Usage:
 *   import { log } from "./report/log.js";
 *
 *   log.info("forward_done", { status: 200, latencyMs: 42 });
 *   log.error("upstream_timeout", { url }, err);
 *   log.debug("routing_request", { model, messages: msgCount });
 *
 * Architecture:
 *   log.info() → emit() → FileLogger (local file) + ILogBackend (remote/console)
 *
 * Design principles (from offload_server's log.ts):
 * 1. Simple API: log.info(msg, data), log.error(msg, data, err)
 * 2. Dual-write: local file + backend simultaneously
 * 3. Error-silent: log failures never block or crash
 * 4. Level filtering: respects minimum log level
 */

import { FileLogger } from "./file-logger.js";
import { ConsoleLogBackend } from "./backends/console.js";
import { NoopLogBackend } from "./backends/noop.js";
import type { ILogBackend, LogAttrs, LogConfig, LogLevel } from "./types.js";
import { LOG_LEVEL_PRIORITY } from "./types.js";

// ─── Module State ────────────────────────────────────────────────────────────

let fileLogger: FileLogger | null = null;
let backend: ILogBackend = new NoopLogBackend();
let minLevel: LogLevel = "info";
let initialized = false;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the logging system.
 * Must be called once at startup (in index.ts).
 * Idempotent: subsequent calls are ignored.
 *
 * @param config Log configuration from ProxyConfig
 * @param customBackend Optional custom ILogBackend (for testing/extension)
 */
export function initLogger(config: LogConfig, customBackend?: ILogBackend): void {
  if (initialized) return;
  initialized = true;

  minLevel = config.level;

  // Initialize file logger
  if (config.filePath) {
    try {
      fileLogger = new FileLogger({
        dir: config.filePath,
        filename: "proxy.log",
        rotateSizeBytes: config.rotate.maxSizeBytes,
        rotateBackupLimit: config.rotate.backupLimit,
      });
    } catch (err) {
      process.stderr.write(`[log] failed to init file logger: ${err}\n`);
    }
  }

  // Set backend
  if (customBackend) {
    backend = customBackend;
  } else {
    switch (config.backend) {
      case "console":
        backend = new ConsoleLogBackend();
        break;
      default:
        backend = new NoopLogBackend();
        break;
    }
  }
}

/**
 * Graceful shutdown: flush all pending data and close streams.
 * Should be called on process exit.
 */
export async function shutdownLogger(): Promise<void> {
  if (fileLogger) {
    await fileLogger.shutdown();
  }
  if (backend) {
    await backend.shutdown();
  }
}

/** Get the current log level (useful for conditional debug). */
export function getLogLevel(): LogLevel {
  return minLevel;
}

// ─── Structured Log API ──────────────────────────────────────────────────────

export const log = {
  /**
   * DEBUG level — verbose diagnostic information.
   * Use for: detailed request/response dumps, internal state transitions.
   */
  debug(event: string, data?: Record<string, unknown>): void {
    emit("debug", event, data);
  },

  /**
   * INFO level — normal operational events.
   * Use for: request lifecycle, routing decisions, usage records.
   */
  info(event: string, data?: Record<string, unknown>): void {
    emit("info", event, data);
  },

  /**
   * WARN level — non-fatal issues that may need attention.
   * Use for: retry attempts, degraded routing, near-limit conditions.
   */
  warn(event: string, data?: Record<string, unknown>): void {
    emit("warn", event, data);
  },

  /**
   * ERROR level — failures that affect the current request.
   * Use for: upstream timeouts, parse errors, 4xx/5xx responses.
   * The err parameter is optional but recommended for stack trace capture.
   */
  error(event: string, data?: Record<string, unknown>, err?: Error): void {
    emit("error", event, data, err);
  },
};

// ─── Internal ────────────────────────────────────────────────────────────────

function emit(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
  err?: Error,
): void {
  // Level filtering
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minLevel]) return;

  try {
    // Build safe attributes (filter non-primitive values)
    const attrs: LogAttrs = {};
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          attrs[key] = value;
        } else {
          // 复杂类型（对象/数组）→ 优先 JSON 序列化保留结构，失败时（如循环引用、
          // BigInt、Symbol）再退回 String() 兜底，避免出现 "[object Object]" 丢失字段。
          // 上限 2000 字符防止单条日志膨胀。
          try {
            attrs[key] = JSON.stringify(value).slice(0, 2000);
          } catch {
            attrs[key] = String(value).slice(0, 200);
          }
        }
      }
    }
    if (err) {
      attrs["error.message"] = err.message;
      attrs["error.name"] = err.name;
    }

    // Dual-write: local file + backend
    fileLogger?.write(level.toUpperCase(), event, data);

    switch (level) {
      case "debug":
        backend.debug(event, attrs);
        break;
      case "info":
        backend.info(event, attrs);
        break;
      case "warn":
        backend.warn(event, attrs);
        break;
      case "error":
        backend.error(event, attrs, err);
        break;
    }
  } catch {
    // Logging errors must never propagate
  }
}
