#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { handleClaudeCodeHook } from "./hook-handler.js";

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf-8");
  const input = raw.trim() ? JSON.parse(raw) : {};
  const timeoutMs = Number.parseInt(process.env.TDAI_GATEWAY_TIMEOUT_MS ?? "", 10);
  const result = await handleClaudeCodeHook(input, {
    gateway: {
      baseUrl: process.env.TDAI_GATEWAY_URL,
      apiKey: process.env.TDAI_GATEWAY_API_KEY,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    },
  });

  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

main().catch((err) => {
  process.stderr.write(`tdai claude-code hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 0;
});
