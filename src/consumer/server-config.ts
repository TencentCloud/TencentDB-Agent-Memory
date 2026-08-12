/**
 * tz-08 Ф3 — what a host tells the MCP server, and what it may assume.
 *
 * Pure resolution, kept out of `mcp-server.ts` so it can be tested without
 * spawning a process: everything here is argv and env in, values out.
 */

import { resolveGatewayPortSource } from "../gateway/address.js";

export { DEFAULT_GATEWAY_PORT } from "../gateway/address.js";

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
  return resolveGatewayAddress(env, argv).url;
}

/**
 * Where the gateway is, and whether a HOST would resolve the same address.
 *
 * A registration is started by the host, from the host's own directory and
 * environment — so an address this shell found through `TDAI_GATEWAY_CONFIG`,
 * a relocation variable, or (when `includeCwd`) a config in the current
 * directory is one the host cannot find again. `isPortable` marks the
 * addresses that survive the paste; everything else has to be written into
 * the snippet.
 *
 * @param includeCwd true only for the PRINTER. The gateway honours a config in
 *   the current directory, so a shell standing there is talking to THAT
 *   gateway and the snippet must freeze its address; a running client must
 *   never let its working directory choose a memory.
 */
export function resolveGatewayAddress(
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = [],
  includeCwd = false,
): { url: string; isPortable: boolean } {
  const explicit = parseFlag(argv, "--gateway") ?? env.TDAI_GATEWAY_URL?.trim();
  if (explicit) return { url: explicit.replace(/\/+$/, ""), isPortable: false };
  const port = Number.parseInt(env.TDAI_GATEWAY_PORT ?? "", 10);
  if (Number.isInteger(port) && port > 0)
    return { url: `http://127.0.0.1:${port}`, isPortable: false };
  // Nobody named an address, so ask the same question the gateway asks itself.
  // Guessing the default here would send a configured install's sessions to a
  // gateway on 8420: nothing answers, or on a machine that runs a default one
  // too, the WRONG memory answers and the next note lands in it.
  const source = resolveGatewayPortSource(includeCwd);
  return {
    url: `http://127.0.0.1:${source.port}`,
    isPortable: source.isPortable,
  };
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
