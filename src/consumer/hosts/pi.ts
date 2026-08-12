/**
 * pi — registers MCP servers in its agent config (see `configPath` below) as an
 * `mcpServers` entry with pi's own `lifecycle` key. pi already exports the
 * gateway into the environment of the servers it starts, so this registration
 * carries no env of its own and no `--host` flag: an unflagged server IS the pi
 * one (server-config.ts).
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
  const args = [ctx.launcherPath];
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
