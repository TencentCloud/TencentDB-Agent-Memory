/**
 * SDK logger — a minimal, silent-by-default logger.
 *
 * Memory is an enhancement, never a critical path: hook scripts must fail
 * silently and never write noise to the host's stdout/stderr. By default this
 * logger discards everything. Set `TDAI_SDK_DEBUG=1` (or pass `{ debug: true }`)
 * to route messages to stderr for troubleshooting.
 *
 * Zero-dependency (no `node:` imports needed).
 */

/**
 * @typedef {Object} Logger
 * @property {(msg: string) => void} [debug]
 * @property {(msg: string) => void} info
 * @property {(msg: string) => void} warn
 * @property {(msg: string) => void} error
 */

/** A logger that discards all messages. */
export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Create a logger.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.debug] Force-enable stderr logging. Defaults to the
 *   truthiness of the `TDAI_SDK_DEBUG` env var.
 * @param {string} [opts.prefix] Optional prefix prepended to every line.
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const enabled =
    opts.debug ?? isTruthy(process.env.TDAI_SDK_DEBUG);
  if (!enabled) return silentLogger;

  const prefix = opts.prefix ? `[${opts.prefix}] ` : "";
  const write = (level, msg) => {
    try {
      process.stderr.write(`${prefix}${level} ${msg}\n`);
    } catch {
      // stderr may be closed (e.g. detached hook) — never throw from a logger.
    }
  };
  return {
    debug: (msg) => write("DEBUG", msg),
    info: (msg) => write("INFO", msg),
    warn: (msg) => write("WARN", msg),
    error: (msg) => write("ERROR", msg),
  };
}

function isTruthy(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
