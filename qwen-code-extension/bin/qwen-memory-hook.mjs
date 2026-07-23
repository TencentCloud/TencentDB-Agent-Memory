#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(extensionDir, "..");

async function loadRunner() {
  try {
    return await import(pathToFileURL(path.join(packageRoot, "dist", "index.mjs")).href);
  } catch {
    return await import(pathToFileURL(path.join(packageRoot, "src", "adapters", "qwen-code", "cli.ts")).href);
  }
}

try {
  const mod = await loadRunner();
  if (typeof mod.runQwenCodeHookCli !== "function") {
    throw new Error("runQwenCodeHookCli export was not found");
  }
  await mod.runQwenCodeHookCli();
} catch (err) {
  console.error(`[tdai-qwen-code] hook wrapper failed open: ${err instanceof Error ? err.message : String(err)}`);
  process.stdout.write(JSON.stringify({ continue: true, decision: "allow" }));
}
