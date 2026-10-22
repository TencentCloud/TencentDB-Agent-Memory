#!/usr/bin/env node

import { loadConfig, resolveMcpCommand } from "./lib/config.mjs";
import { executablePath, probe } from "./lib/health.mjs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

try {
  const json = process.argv.includes("--json");
  const offline = process.argv.includes("--offline");
  const allowRemote = process.argv.includes("--allow-remote");
  const { config, configPath, source } = await loadConfig({ allowRemote });
  const resolvedMcp = await resolveMcpCommand(config, process.env.TDAI_MEMORY_MCP_BIN);
  const mcpPath = await executablePath(resolvedMcp.command);
  const mcpArgs = resolvedMcp.args;
  let mcpEntryOk = true;
  if (mcpArgs[0]?.endsWith(".mjs") || mcpArgs[0]?.endsWith(".js")) {
    try {
      await access(mcpArgs[0], constants.R_OK);
    } catch {
      mcpEntryOk = false;
    }
  }
  const probes = offline
    ? []
    : await Promise.all([
      probe("gateway", process.env.TDAI_GATEWAY_URL || config.gatewayUrl),
      probe("memoryProxy", config.memoryProxyUrl),
    ]);
  const gateway = probes.find((item) => item.name === "gateway");
  const proxy = probes.find((item) => item.name === "memoryProxy");
  const result = {
    ok: Boolean(mcpPath) && mcpEntryOk && (offline || gateway?.ok === true),
    config: { source, path: configPath },
    mcp: {
      ok: Boolean(mcpPath) && mcpEntryOk,
      command: resolvedMcp.command,
      path: mcpPath,
      args: mcpArgs,
      source: resolvedMcp.source,
      upstreamStatus: Boolean(mcpPath) && mcpEntryOk ? "available" : "build MemoryCore first",
    },
    gateway: gateway ?? { skipped: true },
    memoryProxy: proxy ?? { skipped: true },
    notes: [
      "MemoryProxy is optional for MCP tool mode and is never started by this plugin.",
      "A healthy proxy does not imply native Codex support; v2.0.1 limits that adapter to IDE Plan mode.",
    ],
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`MCP executable: ${result.mcp.ok ? "ok" : "missing"}\n`);
    process.stdout.write(`Gateway: ${gateway ? (gateway.ok ? "ok" : "unavailable") : "skipped"}\n`);
    process.stdout.write(`MemoryProxy: ${proxy ? (proxy.ok ? "ok" : "unavailable (optional)") : "skipped"}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
