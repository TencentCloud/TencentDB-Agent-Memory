/**
 * Codex `notify` entry point — capture turns into TencentDB Agent Memory.
 *
 * Codex invokes the configured notify program with a single JSON argument
 * describing the event. Wire it in `~/.codex/config.toml`:
 *
 *   notify = ["npx", "tsx", "/ABS/PATH/adapter-sdk/bindings/codex/notify.ts"]
 *
 * Provide a stable session key via CODEX_SESSION_KEY (optional).
 * Never fails the host: any error exits 0.
 */

import { createAdapterFromEnv } from "../../src/index.js";
import { resolveGatewayConfig } from "../../src/config.js";
import { CodexBinding } from "./binding.js";
import type { CodexTurnCompletePayload } from "./binding.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) process.exit(0);

  let payload: CodexTurnCompletePayload;
  try {
    payload = JSON.parse(arg) as CodexTurnCompletePayload;
  } catch {
    process.exit(0);
  }

  const cfg = resolveGatewayConfig();
  const binding = new CodexBinding({
    userId: cfg.userId,
    sessionKey: process.env.CODEX_SESSION_KEY || undefined,
  });
  const adapter = createAdapterFromEnv(binding);
  await adapter.handleCapture(payload);
  process.exit(0);
}

main().catch(() => process.exit(0));
