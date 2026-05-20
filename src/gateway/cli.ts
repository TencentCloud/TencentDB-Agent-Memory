#!/usr/bin/env node
/**
 * Standalone Gateway daemon entry for host adapters.
 *
 * This bin keeps host plugins small: Codex/Claude-style plugins can spawn
 * `tdai-memory-gateway` from the installed npm package instead of importing
 * package dependencies from the copied plugin directory.
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TdaiGateway } from "./server.js";
import { isLoopbackHost } from "./loopback.js";

function assertSafeHost(): void {
  const host = process.env.TDAI_GATEWAY_HOST?.trim();
  if (!host || isLoopbackHost(host)) return;
  if (process.env.TDAI_GATEWAY_ALLOW_REMOTE === "1" || process.env.TDAI_CODEX_ALLOW_NON_LOOPBACK === "true") {
    return;
  }
  process.stderr.write(
    `tdai-memory-gateway: refusing non-loopback TDAI_GATEWAY_HOST=${host}. ` +
      "Set TDAI_GATEWAY_ALLOW_REMOTE=1 to opt in.\n",
  );
  process.exit(2);
}

function loadTokenFromFile(): void {
  const tokenPath = expandHome(process.env.TDAI_TOKEN_PATH);
  if (!tokenPath) return;
  try {
    const stat = statSync(tokenPath);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      process.stderr.write(`tdai-memory-gateway: token file permissions are too loose: ${tokenPath}\n`);
      process.exit(2);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      process.stderr.write(`tdai-memory-gateway: token file owner mismatch: ${tokenPath}\n`);
      process.exit(2);
    }
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (!token) {
      process.stderr.write(`tdai-memory-gateway: token file is empty: ${tokenPath}\n`);
      process.exit(2);
    }
    // This mutates only Node's in-process env object, not the execve env block.
    process.env.TDAI_GATEWAY_TOKEN = token;
  } catch (err) {
    process.stderr.write(`tdai-memory-gateway: failed to read TDAI_TOKEN_PATH=${tokenPath}: ${String(err)}\n`);
    process.exit(2);
  }
}

function expandHome(value: string | undefined): string {
  if (!value) return "";
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function main(): Promise<void> {
  assertSafeHost();
  loadTokenFromFile();

  const gateway = new TdaiGateway();
  await gateway.start();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        gateway.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch {
      // Best effort shutdown.
    }
    process.exit(reason === "error" ? 1 : 0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const parentPid = Number(process.env.TDAI_CODEX_PARENT_PID || process.env.TDAI_CC_PID || 0);
  if (Number.isFinite(parentPid) && parentPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          clearInterval(timer);
          void shutdown("parent-exit");
        }
      }
    }, 15_000);
    timer.unref();
  }
}

main().catch((err) => {
  process.stderr.write(`tdai-memory-gateway failed: ${String(err)}\n`);
  process.exit(1);
});
