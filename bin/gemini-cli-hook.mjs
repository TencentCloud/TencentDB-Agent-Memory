#!/usr/bin/env node

// Thin launcher for the Gemini CLI memory hook.
// Build: npm run build:gemini-cli-hook

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(thisDir, "../scripts/gemini-cli/dist/hook.js"),
  path.resolve(thisDir, "../scripts/gemini-cli/dist/scripts/gemini-cli/hook.js"),
];
const entry = candidates.find((p) => fs.existsSync(p));

if (!entry) {
  console.error("[memory-tencentdb-gemini] compiled entry not found; run: npm run build:gemini-cli-hook");
  process.exit(1);
}

await import(pathToFileURL(entry).href);
