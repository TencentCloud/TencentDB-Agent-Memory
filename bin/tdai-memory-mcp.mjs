#!/usr/bin/env node

// Thin launcher over the prebuilt stdio-MCP server (tz-08).
// Build:  npm run build
// Run:    node ./bin/tdai-memory-mcp.mjs [--host <id>]
//
// This is the command every host registration writes down, so it must fail
// LOUDLY and legibly when the build is missing — a host that gets a stack
// trace on stdout sees a broken MCP handshake, not a missing build.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const entryScript = path.resolve(thisDir, "../dist/mcp-server.mjs");

if (!fs.existsSync(entryScript)) {
  console.error(`tdai-memory-mcp: build output not found: ${entryScript}`);
  console.error("  Build it first:  npm run build");
  process.exit(1);
}

const { main } = await import(entryScript);
main(process.argv.slice(2), process.env).catch((err) => {
  console.error(
    `tdai-memory-mcp: failed to start: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(1);
});
