#!/usr/bin/env node

// Thin launcher for the TDAI Memory MCP server.
//
// It registers the `tsx` ESM loader in-process, then imports and runs the
// TypeScript entry point directly. Running in-process (rather than spawning a
// child) is deliberate: the MCP stdio transport requires an unbroken pipe
// between the host and THIS process's stdin/stdout.
//
// Usage (installed package):   tdai-memory-mcp
// Usage (repo checkout):       node ./bin/tdai-mcp.mjs
// Requires: a reachable TDAI Gateway (see src/adapters/mcp/README.md).

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "../src/adapters/mcp/server.ts");

async function tryRegisterTsx() {
  try {
    const tsx = await import("tsx/esm/api");
    tsx.register();
    return true;
  } catch (err) {
    process.stderr.write(
      "[tdai-mcp] could not load the tsx loader — is the package installed?\n" +
      `[tdai-mcp] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

if (!(await tryRegisterTsx())) {
  process.exit(1);
}

const mod = await import(pathToFileURL(serverEntry).href);
await mod.runMain();
