#!/usr/bin/env -S npx tsx
/**
 * Claude Code hook CLI.
 *
 * A single entry point invoked by Claude Code hooks. It reads the hook JSON
 * payload from stdin, routes to the right memory operation via the SDK, and
 * writes the hook JSON response to stdout.
 *
 * Usage (wired in .claude/settings.json):
 *   UserPromptSubmit → npx tsx hook-cli.ts recall
 *   Stop            → npx tsx hook-cli.ts capture
 *   SessionEnd      → npx tsx hook-cli.ts session-end
 *
 * Design guarantees:
 *   - NEVER blocks or fails the host turn: on any error we exit 0 with empty
 *     output. Memory is strictly best-effort.
 *   - Zero external deps (built-in fetch + fs).
 */

import { createAdapterFromEnv } from "../../src/index.js";
import { resolveGatewayConfig } from "../../src/config.js";
import { ClaudeCodeBinding } from "./binding.js";
import type {
  UserPromptSubmitPayload,
  StopPayload,
  SessionEndPayload,
} from "./binding.js";

type Mode = "recall" | "capture" | "session-end";

// Silent stderr logger (Claude Code shows stderr in verbose/debug mode only).
const logger = {
  debug: (m: string) => process.env.MEMORY_TENCENTDB_DEBUG && process.stderr.write(`${m}\n`),
  info: (m: string) => process.env.MEMORY_TENCENTDB_DEBUG && process.stderr.write(`${m}\n`),
  warn: (m: string) => process.stderr.write(`${m}\n`),
  error: (m: string) => process.stderr.write(`${m}\n`),
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;
  if (!mode || !["recall", "capture", "session-end"].includes(mode)) {
    process.stderr.write(`Usage: hook-cli.ts <recall|capture|session-end>\n`);
    process.exit(0);
  }

  const rawInput = await readStdin();
  let payload: Record<string, unknown> = {};
  try {
    payload = rawInput ? JSON.parse(rawInput) : {};
  } catch {
    // Malformed hook input — nothing we can do; stay silent.
    process.exit(0);
  }

  const cfg = resolveGatewayConfig();
  const binding = new ClaudeCodeBinding({ userId: cfg.userId });
  const adapter = createAdapterFromEnv(binding, logger);

  if (mode === "recall") {
    const out = await adapter.handleRecall(payload as unknown as UserPromptSubmitPayload);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  if (mode === "capture") {
    await adapter.handleCapture(payload as unknown as StopPayload);
    process.exit(0);
  }

  // session-end
  await adapter.handleSessionEnd(payload as unknown as SessionEndPayload);
  process.exit(0);
}

main().catch((err) => {
  // Absolute last-resort guard: never fail the host turn.
  process.stderr.write(
    `[memory-tencentdb] hook error (ignored): ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(0);
});
