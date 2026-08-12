#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  resolveConfigPath,
  validateConfig,
} from "./lib/config.mjs";

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  if (!process.argv[index + 1]) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: node scripts/setup.mjs [options]\n\n`);
  process.stdout.write(`  --write PATH         Write a non-secret JSON config (default: dry run)\n`);
  process.stdout.write(`  --gateway-url URL    MemoryCore Gateway URL\n`);
  process.stdout.write(`  --proxy-url URL      MemoryProxy health URL\n`);
  process.stdout.write(`  --mcp-bin PATH       Official memory-tencentdb-mcp executable\n`);
  process.stdout.write(`  --allow-remote       Permit trusted non-loopback endpoints\n`);
  process.exit(0);
}

try {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    gatewayUrl: valueAfter("--gateway-url") ?? DEFAULT_CONFIG.gatewayUrl,
    memoryProxyUrl: valueAfter("--proxy-url") ?? DEFAULT_CONFIG.memoryProxyUrl,
    mcpBinary: valueAfter("--mcp-bin") ?? DEFAULT_CONFIG.mcpBinary,
    mcpArgs: [],
  }, { allowRemote: process.argv.includes("--allow-remote") });
  const output = `${JSON.stringify(config, null, 2)}\n`;
  const writeTarget = valueAfter("--write");
  if (!writeTarget) {
    process.stdout.write(output);
    process.stderr.write("Dry run only. Pass --write PATH to save this non-secret config.\n");
    process.exit(0);
  }
  const target = resolveConfigPath(path.resolve(writeTarget));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, output, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`Wrote ${target}\n`);
  process.stdout.write("API keys are intentionally read from the process environment and were not written.\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
