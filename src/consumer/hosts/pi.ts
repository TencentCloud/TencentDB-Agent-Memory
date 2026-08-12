/**
 * pi — registers MCP servers in its agent config (see `configPath` below) as an
 * `mcpServers` entry with pi's own `lifecycle` key. The registration carries no
 * `--host` flag: an unflagged server IS the pi one (server-config.ts). The
 * gateway address, when the caller names one, travels on the command line like
 * it does for every other host — pi's entries hold a command and args, and
 * whether it forwards environment is its own business, not something a printed
 * snippet may assume.
 *
 * The path literal below is the ONE exemption this file holds from the tz-07
 * host-path guard (scripts/check-no-pi-hardcode.sh): it tells a user which of
 * THEIR files to paste into. Nothing here resolves, opens or writes it, and the
 * guard fails if this file ever touches the filesystem.
 */
import {
  MCP_SERVER_NAME,
  type HostContext,
  type HostDescriptor,
} from "./types.js";

export function piHost(ctx: HostContext): HostDescriptor {
  const args = ctx.gatewayUrl
    ? [ctx.launcherPath, "--gateway", ctx.gatewayUrl]
    : [ctx.launcherPath];
  return {
    id: "pi",
    configPath: "~/.pi/agent/mcp.json",
    command: "node",
    args,
    env: {},
    registration: () =>
      JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: { command: "node", args, lifecycle: "lazy" },
          },
        },
        null,
        2,
      ),
  };
}
