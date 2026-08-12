/**
 * Codex — registers MCP servers in `~/.codex/config.toml` under
 * `[mcp_servers.<name>]`. TOML, not JSON: the same server, written down in the
 * only shape that file accepts.
 */
import {
  MCP_SERVER_NAME,
  type HostContext,
  type HostDescriptor,
} from "./types.js";

/** TOML string array, e.g. `["a", "b"]`. */
const tomlArray = (values: readonly string[]): string =>
  `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

export function codexHost(ctx: HostContext): HostDescriptor {
  const args = [ctx.launcherPath, "--host", "codex"];
  const env: Record<string, string> = ctx.gatewayUrl
    ? { TDAI_GATEWAY_URL: ctx.gatewayUrl }
    : {};
  return {
    id: "codex",
    configPath: "~/.codex/config.toml",
    command: "node",
    args,
    env,
    registration: () => {
      const lines = [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `command = "node"`,
        `args = ${tomlArray(args)}`,
      ];
      if (ctx.gatewayUrl) {
        lines.push(
          `[mcp_servers.${MCP_SERVER_NAME}.env]`,
          `TDAI_GATEWAY_URL = ${JSON.stringify(ctx.gatewayUrl)}`,
        );
      }
      return lines.join("\n");
    },
  };
}
