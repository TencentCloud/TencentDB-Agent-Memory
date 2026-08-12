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
 * A registration carries the address in `--gateway` because that is the one
 * thing every host config can express — a JSON `mcpServers` entry, a TOML
 * block and pi's own file all write down a command line, while passing
 * environment through is each host's own business. `TDAI_GATEWAY_URL` still
 * wins over the default for the host that exports it itself (the pi
 * extension does), and neither present means the ordinary local case: the
 * loopback gateway on its documented port, which stays in step with
 * `TDAI_GATEWAY_PORT` instead of being frozen into a URL literal.
 */
export function resolveGatewayUrl(
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = [],
): string {
  const explicit = parseFlag(argv, "--gateway") ?? env.TDAI_GATEWAY_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number.parseInt(env.TDAI_GATEWAY_PORT ?? "", 10);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : DEFAULT_GATEWAY_PORT}`;
}

/** The value of `--name value`, or undefined when the flag carries none. */
function parseFlag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  const value = at >= 0 ? argv[at + 1]?.trim() : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * Which host is running this server (`--host claude`).
 *
 * It is not decoration: the id names the note's session, so what a host wrote
 * stays attributable to that host. An unnamed host is the pi extension, which
 * registers the server without flags.
 */
export function parseHostId(argv: readonly string[]): string {
  return parseFlag(argv, "--host") ?? DEFAULT_HOST_ID;
}

/** Session a host's notes are recorded under. */
export function sessionKeyFor(hostId: string): string {
  return `tdai-mcp-${hostId}`;
}
