#!/usr/bin/env node
/**
 * Cross-platform postinstall hook.
 *
 * The OpenClaw runtime patch is a Bash-only convenience. It should never make
 * npm install fail, and it is not relevant for Windows-native Hermes installs.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const patchScript = path.join(scriptDir, "openclaw-after-tool-call-messages.patch.sh");

function log(message) {
  console.log(`[memory-tencentdb] postinstall: ${message}`);
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function skip(message) {
  log(`${message}; skipping OpenClaw patch.`);
  process.exit(0);
}

if (process.platform === "win32") {
  skip("Windows detected");
}

if (!["linux", "darwin"].includes(process.platform)) {
  skip(`unsupported platform ${process.platform}`);
}

if (
  isTruthy(process.env.MEMORY_TENCENTDB_SKIP_OPENCLAW_PATCH) ||
  process.env.MEMORY_TENCENTDB_MODE === "hermes" ||
  process.env.HERMES_HOME ||
  process.env.HERMES_AGENT_DIR
) {
  skip("Hermes install context detected");
}

if (!existsSync(patchScript)) {
  skip(`patch script not found at ${patchScript}`);
}

const bashCheck = spawnSync("bash", ["--version"], { stdio: "ignore" });
if (bashCheck.error) {
  skip("bash not found");
}

log("running OpenClaw after-tool-call patch");
const result = spawnSync("bash", [patchScript], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  log(`patch could not start (${result.error.message}); continuing npm install.`);
  process.exit(0);
}

if (result.status !== 0) {
  log(`patch exited with status ${result.status}; continuing npm install.`);
}

process.exit(0);
