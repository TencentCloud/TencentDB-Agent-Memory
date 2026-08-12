/**
 * Claude Code — registers MCP servers in `~/.claude.json` under `mcpServers`,
 * with an explicit `"type": "stdio"`. The gateway address, when the caller
 * names one, rides on the command line: every host config can express args,
 * and one mechanism for all three beats three ways of saying the same thing.
 */
import {
  MCP_SERVER_NAME,
  type HostContext,
  type HostDescriptor,
} from "./types.js";

export function claudeHost(ctx: HostContext): HostDescriptor {
  const args = [
    ctx.launcherPath,
    "--host",
    "claude",
    ...(ctx.gatewayUrl ? ["--gateway", ctx.gatewayUrl] : []),
  ];
  const env: Record<string, string> = {};
  return {
    id: "claude",
    configPath: "~/.claude.json",
    command: "node",
    args,
    env,
    registration: () =>
      JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: { type: "stdio", command: "node", args, env },
          },
        },
        null,
        2,
      ),
  };
}
