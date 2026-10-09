/**
 * SDK configuration resolution.
 *
 * Resolves the Gateway connection details from environment variables so every
 * binding (Claude Code hook CLI, MCP server, Codex, …) shares one convention.
 *
 * Env vars (aligned with the Hermes provider so a shared Gateway "just works"):
 *   MEMORY_TENCENTDB_GATEWAY_HOST     (default: 127.0.0.1)
 *   MEMORY_TENCENTDB_GATEWAY_PORT     (default: 8420)
 *   MEMORY_TENCENTDB_GATEWAY_URL      (optional; overrides host/port)
 *   MEMORY_TENCENTDB_GATEWAY_API_KEY  (optional; fallback: TDAI_GATEWAY_API_KEY)
 *   MEMORY_TENCENTDB_USER_ID          (optional; default: default_user)
 */

export interface ResolvedGatewayConfig {
  baseUrl: string;
  apiKey?: string;
  userId: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8420;

function env(key: string): string | undefined {
  const v = process.env[key];
  if (v == null) return undefined;
  const t = v.trim();
  return t || undefined;
}

function resolvePort(): number {
  const raw = env("MEMORY_TENCENTDB_GATEWAY_PORT");
  if (!raw) return DEFAULT_PORT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

export function resolveGatewayConfig(): ResolvedGatewayConfig {
  const explicitUrl = env("MEMORY_TENCENTDB_GATEWAY_URL");
  const host = env("MEMORY_TENCENTDB_GATEWAY_HOST") ?? DEFAULT_HOST;
  const port = resolvePort();
  const baseUrl = explicitUrl ?? `http://${host}:${port}`;

  const apiKey =
    env("MEMORY_TENCENTDB_GATEWAY_API_KEY") ?? env("TDAI_GATEWAY_API_KEY");

  const userId = env("MEMORY_TENCENTDB_USER_ID") ?? "default_user";

  return { baseUrl, apiKey, userId };
}
