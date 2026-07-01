#!/usr/bin/env node
// Example launcher for the optional Codex hook adapter.
// Build: npx tsc -p examples/codex/hooks-adapter/tsconfig.json
// Use:   node /absolute/path/to/examples/codex/hooks-adapter/memory-tencentdb-codex-hook.mjs

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(thisDir, "dist/examples/codex/hooks-adapter/codex-hooks-adapter.js"),
  path.resolve(thisDir, "dist/codex-hooks-adapter.js"),
];

const entry = candidates.find((candidate) => existsSync(candidate));

if (!entry) {
  console.error("Precompiled Codex hook example not found. Checked:");
  for (const candidate of candidates) {
    console.error(`  - ${candidate}`);
  }
  console.error("Please run: npx tsc -p examples/codex/hooks-adapter/tsconfig.json");
  process.exit(1);
}

const mod = await import(entry);
try {
  await mod.main();
} catch (err) {
  console.error(`[memory-tencentdb-codex-hook] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
