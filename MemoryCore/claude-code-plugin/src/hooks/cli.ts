#!/usr/bin/env node
/**
 * Hook entry: Claude Code pipes the hook payload on stdin and reads one JSON
 * object from stdout. Any failure prints `{}` so the session continues.
 */

import { loadConfig } from "../config.js";
import { createMemoryClient } from "../client.js";
import { handleHook, type HookInput } from "./handler.js";
import { PluginState } from "./state.js";

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as HookInput;
    const config = loadConfig();
    const output = await handleHook(input, {
      config,
      state: new PluginState(config.stateDir),
      recallClient: createMemoryClient(config, config.recallTimeoutMs),
      captureClient: createMemoryClient(config, config.captureTimeoutMs),
      log: (message) => process.stderr.write(`[tdai][claude-code] ${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`[tdai][claude-code] hook failed open: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write("{}\n");
  }
}

void main();
