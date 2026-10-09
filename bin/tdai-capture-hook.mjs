#!/usr/bin/env node
/**
 * Launcher for the Claude Code Stop hook.
 * Runs tdai-capture-hook.ts via tsx (production dependency).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const tsxLocal = path.resolve(thisDir, "../node_modules/.bin/tsx");
const tsxBin = fs.existsSync(tsxLocal) ? tsxLocal : "tsx";
const entry = path.resolve(thisDir, "./tdai-capture-hook.ts");

if (!fs.existsSync(entry)) {
  process.stderr.write(`[tdai-hook] Fatal: entry not found: ${entry}\n`);
  process.exit(0); // Always exit 0 — hooks must not block Claude Code
}

const child = spawn(tsxBin, [entry], { stdio: "inherit", env: process.env });
child.on("exit", () => process.exit(0)); // always exit 0 — hooks must not block Claude Code
