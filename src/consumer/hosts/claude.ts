/**
 * Claude Code — registers MCP servers in `~/.claude.json` under `mcpServers`,
 * with an explicit `"type": "stdio"`. It does not export the gateway itself,
 * so the URL is baked into the registration's env.
 */
import {
  MCP_SERVER_NAME,
  type HostContext,
  type HostDescriptor,
} from "./types.js";

export function claudeHost(ctx: HostContext): HostDescriptor {
  const args = [ctx.launcherPath, "--host", "claude"];
  const env: Record<string, string> = ctx.gatewayUrl
    ? { TDAI_GATEWAY_URL: ctx.gatewayUrl }
    : {};
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
