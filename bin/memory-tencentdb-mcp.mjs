#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const builtServer = new URL("../dist/integrations/shared/mcp-server.mjs", import.meta.url);
const sourceServer = new URL("../src/integrations/shared/mcp-server.ts", import.meta.url);
const serverArgs = existsSync(fileURLToPath(builtServer))
  ? [fileURLToPath(builtServer)]
  : ["--import", "tsx", fileURLToPath(sourceServer)];

const child = spawn(process.execPath, [...serverArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error(`[memory-tencentdb-mcp] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
