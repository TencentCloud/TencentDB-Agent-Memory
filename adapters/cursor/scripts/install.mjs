#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const target = path.resolve(valueAfter("--target") || path.join(os.homedir(), ".cursor", "plugins", "local", "tencentdb-agent-memory"));
const dryRun = args.includes("--dry-run");

if (target === adapterRoot || target.startsWith(`${adapterRoot}${path.sep}`)) {
  throw new Error("Install target must not be inside the adapter source directory.");
}

const quoteCmd = (value) => `"${value.replace(/"/g, '""')}"`;
const quoteSh = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function generateInstalledConfig() {
  const scripts = path.join(target, "scripts");
  const isWindows = process.platform === "win32";
  const hookRunner = path.join(scripts, isWindows ? "hook-runner.cmd" : "hook-runner.sh");
  const mcpRunner = path.join(scripts, isWindows ? "mcp-runner.cmd" : "mcp-runner.sh");
  if (isWindows) {
    await writeFile(hookRunner, `@echo off\r\nchcp 65001 >nul\r\n${quoteCmd(process.execPath)} ${quoteCmd(path.join(scripts, "hook.mjs"))}\r\n`, "utf8");
    await writeFile(mcpRunner, `@echo off\r\n${quoteCmd(process.execPath)} ${quoteCmd(path.join(scripts, "mcp-server.mjs"))}\r\n`, "utf8");
  } else {
    await writeFile(hookRunner, `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(path.join(scripts, "hook.mjs"))}\n`, "utf8");
    await writeFile(mcpRunner, `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(path.join(scripts, "mcp-server.mjs"))}\n`, "utf8");
    await chmod(hookRunner, 0o755);
    await chmod(mcpRunner, 0o755);
  }

  const hooks = JSON.parse(await readFile(path.join(target, "hooks", "hooks.json"), "utf8"));
  for (const entries of Object.values(hooks.hooks)) {
    for (const entry of entries) entry.command = hookRunner;
  }
  await writeFile(path.join(target, "hooks", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`, "utf8");

  const mcp = JSON.parse(await readFile(path.join(target, "mcp.json"), "utf8"));
  const server = mcp.mcpServers["tencentdb-agent-memory"];
  server.command = mcpRunner;
  server.args = [];
  server.cwd = target;
  await writeFile(path.join(target, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ source: adapterRoot, target, node: process.execPath, platform: process.platform }, null, 2)}\n`);
} else {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(adapterRoot, target, { recursive: true, force: true });
  await generateInstalledConfig();
  process.stdout.write(`Installed TencentDB Agent Memory Cursor adapter to ${target}\nReload Cursor, then enable the local plugin in Customize -> Plugins.\n`);
}
