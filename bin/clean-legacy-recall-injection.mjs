#!/usr/bin/env node

// Thin launcher for the legacy recall-injection cleanup CLI.
// Build: npm run build:clean-legacy-recall-injection

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(
  thisDir,
  "../scripts/clean-legacy-recall-injection/dist/scripts/clean-legacy-recall-injection/cli-entry.js",
);

if (!fs.existsSync(entry)) {
  console.error("[clean-legacy-recall-injection] compiled entry not found; run: npm run build:clean-legacy-recall-injection");
  process.exit(1);
}

await import(pathToFileURL(entry).href);