#!/usr/bin/env node

import { spawn } from "node:child_process";
import { loadConfig, resolveMcpCommand } from "./lib/config.mjs";

const allowRemote = process.argv.includes("--allow-remote")
  || process.env.TDAI_ALLOW_REMOTE === "1";

try {
  const { config } = await loadConfig({ allowRemote });
  const resolved = await resolveMcpCommand(config, process.env.TDAI_MEMORY_MCP_BIN);
  const child = spawn(resolved.command, resolved.args, {
    env: {
      ...process.env,
      TDAI_GATEWAY_URL: process.env.TDAI_GATEWAY_URL || config.gatewayUrl,
    },
    shell: false,
    stdio: "inherit",
  });

  child.once("error", (error) => {
    const detail = error.code === "ENOENT"
      ? `Official MCP executable not found: ${resolved.command}. Build MemoryCore, install its package so memory-tencentdb-mcp is on PATH, or set TDAI_MEMORY_MCP_BIN.`
      : error.message;
    process.stderr.write(`[tdai-memory-plugin] ${detail}\n`);
    process.exitCode = 127;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
} catch (error) {
  process.stderr.write(`[tdai-memory-plugin] ${error.message}\n`);
  process.exitCode = 2;
}
