#!/usr/bin/env node
// Thin launcher for the precompiled Codex hook adapter.
// Build: npm run build:codex-hooks-adapter
// Use:   memory-tencentdb-codex-hook

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(thisDir, "../scripts/codex-hooks-adapter/dist/scripts/codex-hooks-adapter/codex-hooks-adapter.js"),
  path.resolve(thisDir, "../scripts/codex-hooks-adapter/dist/codex-hooks-adapter.js"),
];

const entry = candidates.find((candidate) => existsSync(candidate));

if (!entry) {
  console.error("Precompiled Codex hook adapter not found. Checked:");
  for (const candidate of candidates) {
    console.error(`  - ${candidate}`);
  }
  console.error("Please run: npm run build:codex-hooks-adapter");
  process.exit(1);
}

const mod = await import(entry);
try {
  await mod.main();
} catch (err) {
  console.error(`[memory-tencentdb-codex-hook] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
