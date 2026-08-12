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
  const args = [
    ctx.launcherPath,
    "--host",
    "codex",
    ...(ctx.gatewayUrl ? ["--gateway", ctx.gatewayUrl] : []),
  ];
  const env: Record<string, string> = {};
  return {
    id: "codex",
    configPath: "~/.codex/config.toml",
    command: "node",
    args,
    env,
    registration: () => {
      return [
        `[mcp_servers.${MCP_SERVER_NAME}]`,
        `command = "node"`,
        `args = ${tomlArray(args)}`,
      ].join("\n");
    },
  };
}
