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

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function runPostinstall({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  spawn = spawnSync,
  logger = console.log,
  directory = scriptDir,
} = {}) {
  const repoRoot = path.dirname(directory);
  const patchScript = path.join(directory, "openclaw-after-tool-call-messages.patch.sh");
  const log = (message) => logger(`[memory-tencentdb] postinstall: ${message}`);
  const skip = (message) => {
    log(`${message}; skipping OpenClaw patch.`);
    return 0;
  };

  if (platform === "win32") {
    return skip("Windows detected");
  }

  if (!["linux", "darwin"].includes(platform)) {
    return skip(`unsupported platform ${platform}`);
  }

  if (
    isTruthy(env.MEMORY_TENCENTDB_SKIP_OPENCLAW_PATCH) ||
    env.MEMORY_TENCENTDB_MODE === "hermes" ||
    env.HERMES_HOME ||
    env.HERMES_AGENT_DIR
  ) {
    return skip("Hermes install context detected");
  }

  if (!exists(patchScript)) {
    return skip(`patch script not found at ${patchScript}`);
  }

  const bashCheck = spawn("bash", ["--version"], { stdio: "ignore" });
  if (bashCheck.error || bashCheck.status !== 0) {
    return skip("bash not found");
  }

  log("running OpenClaw after-tool-call patch");
  const result = spawn("bash", [patchScript], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    log(`patch could not start (${result.error.message}); continuing npm install.`);
  } else if (result.status !== 0) {
    log(`patch exited with status ${result.status}; continuing npm install.`);
  }

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPostinstall();
}
