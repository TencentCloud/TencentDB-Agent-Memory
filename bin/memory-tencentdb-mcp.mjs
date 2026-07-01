#!/usr/bin/env node

// Thin launcher for the precompiled MCP stdio adapter.
// Build: npm run build:mcp-adapter
// Use:   memory-tencentdb-mcp

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryCandidates = [
  path.resolve(thisDir, "../scripts/mcp-adapter/dist/scripts/mcp-adapter/mcp-adapter.js"),
  path.resolve(thisDir, "../scripts/mcp-adapter/dist/mcp-adapter.js"),
];
const entryScript = entryCandidates.find((candidate) => fs.existsSync(candidate));

if (!entryScript) {
  console.error("Precompiled MCP adapter not found. Checked:");
  for (const candidate of entryCandidates) {
    console.error("  - " + candidate);
  }
  console.error("Please run: npm run build:mcp-adapter");
  process.exit(1);
}

const mod = await import(entryScript);
await mod.main();
