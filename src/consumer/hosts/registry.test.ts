/**
 * tz-08 Ф4 — the three hosts are genuinely three, and an unknown one is refused.
 *
 * The argv comparison is not pedantry: the parity test (Ф5) launches processes
 * with exactly what the registry hands back, so if the three descriptors ever
 * collapsed into the same command line, that test would be comparing one host
 * with itself and would keep passing while proving nothing.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  describeAllHosts,
  describeHost,
  KNOWN_HOSTS,
  LauncherNotFoundError,
  resolveLauncherPath,
} from "./registry.js";
import { MCP_SERVER_NAME } from "./types.js";

const ctx = {
  launcherPath: "/opt/tdai/bin/tdai-memory-mcp.mjs",
  gatewayUrl: "http://127.0.0.1:8420",
};

describe("host registry", () => {
  it("knows exactly pi, claude and codex", () => {
    expect([...KNOWN_HOSTS].sort()).toEqual(["claude", "codex", "pi"]);
  });

  it("refuses an unknown host as a value, naming the ones that work", () => {
    const r = describeHost("emacs", ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("incompatible-host");
    expect(r.message).toContain("claude");
    expect(r.known).toEqual(KNOWN_HOSTS);
  });

  it("starts every host with node and the prebuilt launcher, never a TS loader", () => {
    for (const d of describeAllHosts(ctx)) {
      expect([d.id, d.command, d.args[0]]).toEqual([
        d.id,
        "node",
        ctx.launcherPath,
      ]);
      expect(d.registration()).not.toContain("tsx");
    }
  });

  it("gives the three hosts three different command lines", () => {
    const argvs = describeAllHosts(ctx).map((d) => JSON.stringify(d.args));
    expect(new Set(argvs).size).toBe(3);
  });

  it("writes each registration in the format its own config file accepts", () => {
    const [pi, claude, codex] = describeAllHosts(ctx);

    // pi and claude: JSON, and it has to parse.
    for (const host of [pi!, claude!]) {
      const parsed = JSON.parse(host.registration()) as {
        mcpServers: Record<string, { command: string }>;
      };
      expect(parsed.mcpServers[MCP_SERVER_NAME]?.command).toBe("node");
    }
    // No host is handed anything through the environment: the address travels
    // on the command line, where every config format can carry it.
    expect(pi!.env).toEqual({});
    expect(pi!.registration()).toContain("lifecycle");
    expect(claude!.registration()).toContain(`"type": "stdio"`);
    // Every host is told where the gateway is the same way — on the command
    // line, the one thing all three config formats can express.
    for (const host of [pi!, claude!, codex!])
      expect(host.args).toContain(ctx.gatewayUrl);

    // codex: TOML, not JSON.
    expect(codex!.registration()).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(codex!.registration()).toContain(`args = [`);
    expect(() => JSON.parse(codex!.registration())).toThrow();
  });

  it("names each host's own config file", () => {
    expect(describeAllHosts(ctx).map((d) => d.configPath)).toEqual([
      "~/.pi/agent/mcp.json",
      "~/.claude.json",
      "~/.codex/config.toml",
    ]);
  });
});

describe("locating the launcher", () => {
  it("finds the real launcher of this checkout", () => {
    const found = resolveLauncherPath();
    expect(fs.existsSync(found)).toBe(true);
    expect(found.endsWith("/bin/tdai-memory-mcp.mjs")).toBe(true);
  });

  it("fails loudly when the package layout is not what it expects", () => {
    expect(() => resolveLauncherPath("/")).toThrow(LauncherNotFoundError);
  });
});
