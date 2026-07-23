import { pathToFileURL } from "node:url";
import { loadClaudeCodeAdapterConfig } from "../config.js";
import { mapPostToolUseInput } from "../mappers/tool-event.js";
import { shouldCaptureToolEvent } from "../short-term/filter.js";
import { recordShortTermToolEvent } from "../short-term/store.js";
import type { ClaudeCodeHookInput } from "../types.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handlePostToolUse(
  input: ClaudeCodeHookInput,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<Record<string, never>> {
  const config = loadClaudeCodeAdapterConfig(options?.env);
  if (!config.shortTermEnabled) return {};

  const event = mapPostToolUseInput(input);
  const decision = shouldCaptureToolEvent(event);
  recordShortTermToolEvent({
    event,
    decision,
    storageDir: config.storageDir,
  });
  return {};
}

export async function runPostToolUseHook(): Promise<void> {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) as ClaudeCodeHookInput : {};
  const output = await handlePostToolUse(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPostToolUseHook().catch((err) => {
    console.error(`[memory-tencentdb:claude-code] PostToolUse hook failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
