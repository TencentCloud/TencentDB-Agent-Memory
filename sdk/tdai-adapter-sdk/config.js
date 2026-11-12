/**
 * SDK configuration resolution.
 *
 * Centralises how the Gateway URL, optional Bearer token, and default timeout
 * are discovered from the environment, so every hook script and the MCP bridge
 * agree on the same wiring.
 *
 * Env:
 *   TDAI_GATEWAY_URL       Gateway base URL (default http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY   Optional Bearer token (matches the Gateway's
 *                          server.apiKey / TDAI_GATEWAY_API_KEY). When set,
 *                          every outbound request attaches
 *                          `Authorization: Bearer <key>`.
 *   TDAI_GATEWAY_TIMEOUT_MS Default per-request timeout in ms (optional).
 *
 * Zero-dependency.
 */

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
export const DEFAULT_TIMEOUT_MS = 12000;

/**
 * @typedef {Object} ResolvedConfig
 * @property {string} baseUrl
 * @property {string|undefined} apiKey
 * @property {number} timeoutMs
 */

/**
 * Resolve SDK config from explicit overrides falling back to env vars.
 *
 * @param {Object} [overrides]
 * @param {string} [overrides.baseUrl]
 * @param {string} [overrides.apiKey]
 * @param {number} [overrides.timeoutMs]
 * @param {NodeJS.ProcessEnv} [env] Environment source (defaults to process.env).
 * @returns {ResolvedConfig}
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const baseUrl =
    overrides.baseUrl ?? env.TDAI_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;

  // Strip whitespace defensively — env vars often pick up trailing newlines
  // from `echo` or YAML quoting; an exact-match Bearer comparison on the
  // Gateway would otherwise reject a key that "looks right".
  const rawKey = overrides.apiKey ?? env.TDAI_GATEWAY_API_KEY;
  const apiKey = (rawKey || "").trim() || undefined;

  const timeoutMs =
    overrides.timeoutMs ??
    toPositiveInt(env.TDAI_GATEWAY_TIMEOUT_MS) ??
    DEFAULT_TIMEOUT_MS;

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, timeoutMs };
}

function toPositiveInt(v) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
