#!/usr/bin/env node

/**
 * Gemini CLI hook entrypoint.
 *
 * Reads one hook JSON object from stdin and writes the hook output JSON to
 * stdout. All diagnostics go to stderr; stdout must stay JSON-only.
 */

import { readFileSync } from "node:fs";
import {
  TdaiGatewayClient,
  resolveGatewayClientOptions,
  handleGeminiCliHook,
} from "../../src/adapters/gemini-cli/index.js";

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw) as Record<string, unknown>;
  const client = new TdaiGatewayClient(resolveGatewayClientOptions(process.env));
  const output = await handleGeminiCliHook(input, client);
  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  process.stderr.write(`[memory-tencentdb-gemini] hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stdout.write("{}");
});
