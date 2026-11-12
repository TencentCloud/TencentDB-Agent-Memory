#!/usr/bin/env node
/**
 * Sync (vendor-copy) the TDAI Adapter SDK into each platform plugin so the
 * plugin directories stay independently distributable and zero-dependency.
 *
 *   sdk/tdai-adapter-sdk/  →  <plugin>/vendor/tdai-sdk/
 *
 * Copies runtime files only (*.js + types.d.ts); tests and docs stay in the
 * SDK source. Run after any SDK change:  npm run build:adapters
 */

import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = join(repoRoot, "sdk", "tdai-adapter-sdk");

const PLUGIN_DIRS = ["whale-memory-tdai", "codex-memory-tdai"];

const files = readdirSync(sdkDir).filter(
  (f) => (f.endsWith(".js") || f === "types.d.ts") && !f.endsWith(".test.ts"),
);

for (const plugin of PLUGIN_DIRS) {
  const vendorDir = join(repoRoot, plugin, "vendor", "tdai-sdk");
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });
  for (const f of files) {
    cpSync(join(sdkDir, f), join(vendorDir, f));
  }
  console.log(`synced ${files.length} files → ${plugin}/vendor/tdai-sdk/`);
}
