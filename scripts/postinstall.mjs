#!/usr/bin/env node
/**
 * Cross-platform postinstall hook.
 * OpenClaw runtime patch has been removed — the after_tool_call hook now uses
 * the official OpenClaw getSessionMessages API instead. See #851.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export function runPostinstall({
  logger = console.log,
  directory = scriptDir,
} = {}) {
  const log = (message) => logger(`[memory-tencentdb] postinstall: ${message}`);
  log("postinstall complete — no OpenClaw runtime patch needed (see #851).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runPostinstall();
}
