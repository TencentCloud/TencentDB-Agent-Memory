#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const builtBridge = new URL("../dist/integrations/shared/hook-bridge.mjs", import.meta.url);
const sourceBridge = new URL("../src/integrations/shared/hook-bridge.ts", import.meta.url);
const bridgeArgs = existsSync(fileURLToPath(builtBridge))
  ? [fileURLToPath(builtBridge)]
  : ["--import", "tsx", fileURLToPath(sourceBridge)];

const child = spawn(process.execPath, [...bridgeArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error(`[memory-tencentdb-hook] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
