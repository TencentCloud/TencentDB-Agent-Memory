#!/usr/bin/env node
/**
 * Launcher for the Claude Code MCP server.
 *
 * Uses tsx (a production dependency of this package) to execute the
 * TypeScript entry point without a separate pre-compilation step.
 *
 * All configuration is read from environment variables — see
 * bin/tdai-claude-code-mcp.ts for the full list.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// Prefer the local tsx binary; fall back to PATH resolution
const tsxLocal = path.resolve(thisDir, "../node_modules/.bin/tsx");
const tsxBin = fs.existsSync(tsxLocal) ? tsxLocal : "tsx";

const entry = path.resolve(thisDir, "./tdai-claude-code-mcp.ts");

if (!fs.existsSync(entry)) {
  process.stderr.write(
    `[tdai] Fatal: entry point not found: ${entry}\n` +
    `[tdai] Ensure the package is installed correctly.\n`,
  );
  process.exit(1);
}

const child = spawn(tsxBin, [entry], {
  stdio: "inherit",
  env: process.env,
});

process.on("SIGTERM", () => { child.kill("SIGTERM"); });
process.on("SIGINT", () => { child.kill("SIGINT"); });
child.on("exit", (code) => process.exit(code ?? 0));
