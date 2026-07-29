#!/usr/bin/env node
/**
 * Cross-platform postinstall wrapper.
 *
 * The OpenClaw patch script is bash-only; on Windows `bash` may be missing or
 * point to the WSL launcher, and `|| true` is not a cmd.exe builtin — both
 * break `npm install`. The patch is a best-effort optimization for OpenClaw
 * hosts, so this wrapper runs it only where bash works and never fails.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "openclaw-after-tool-call-messages.patch.sh",
  );
  try {
    spawnSync("bash", [script], { stdio: "ignore" });
  } catch {
    // bash unavailable — skip silently
  }
}

process.exit(0);
