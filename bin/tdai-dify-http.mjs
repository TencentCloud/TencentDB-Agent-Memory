#!/usr/bin/env node
/**
 * Launcher for the Dify HTTP server.
 * Runs tdai-dify-http.ts via tsx (production dependency).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const tsxLocal = path.resolve(thisDir, "../node_modules/.bin/tsx");
const tsxBin = fs.existsSync(tsxLocal) ? tsxLocal : "tsx";
const entry = path.resolve(thisDir, "./tdai-dify-http.ts");

if (!fs.existsSync(entry)) {
  process.stderr.write(`[tdai-dify-http] Fatal: entry not found: ${entry}\n`);
  process.exit(1);
}

const child = spawn(tsxBin, [entry], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
