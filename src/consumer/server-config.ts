/**
 * tz-08 Ф3 — what a host tells the MCP server, and what it may assume.
 *
 * Pure resolution, kept out of `mcp-server.ts` so it can be tested without
 * spawning a process: everything here is argv and env in, values out.
 */

/** The gateway's own default (gateway/config.ts:164) — one number, one place. */
export const DEFAULT_GATEWAY_PORT = 8420;

/** Host id used when a host registers the server without naming itself. */
export const DEFAULT_HOST_ID = "pi";

/**
 * Where the gateway is.
 *
 * `TDAI_GATEWAY_URL` is what the Claude/Codex registrations set; `TDAI_GATEWAY`
 * is what the pi extension already exports. Neither present means the ordinary
 * local case — the loopback gateway on its documented port, which stays in
 * step with `TDAI_GATEWAY_PORT` rather than being frozen into a URL literal.
 */
export function resolveGatewayUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.TDAI_GATEWAY_URL?.trim() || env.TDAI_GATEWAY?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number.parseInt(env.TDAI_GATEWAY_PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : DEFAULT_GATEWAY_PORT}`;
}

/**
 * Which host is running this server (`--host claude`).
 *
 * It is not decoration: the id names the note's session, so what a host wrote
 * stays attributable to that host. An unnamed host is the pi extension, which
 * registers the server without flags.
 */
export function parseHostId(argv: readonly string[]): string {
  const at = argv.indexOf("--host");
  const value = at >= 0 ? argv[at + 1]?.trim() : undefined;
  return value && !value.startsWith("--") ? value : DEFAULT_HOST_ID;
}

/** Session a host's notes are recorded under. */
export function sessionKeyFor(hostId: string): string {
  return `tdai-mcp-${hostId}`;
}
