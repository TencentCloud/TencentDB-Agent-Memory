#!/usr/bin/env node

import {
  createClaudeCodeHookDependenciesFromEnv,
  handleClaudeCodeHook,
  parseClaudeCodeHookInput,
} from "./hook-handler.js";

const MAX_STDIN_BYTES = 1024 * 1024;

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const input = parseClaudeCodeHookInput(JSON.parse(raw));
    if (!input) return writeOutput({});

    const output = await handleClaudeCodeHook(
      input,
      createClaudeCodeHookDependenciesFromEnv(input),
    );
    writeOutput(output);
  } catch (error) {
    if (/^(1|true|yes)$/i.test(process.env.TDAI_CLAUDE_CODE_DEBUG ?? "")) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[memory-tencentdb:claude-code] hook failed open: ${message}\n`);
    }
    writeOutput({});
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error("Claude Code hook input exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeOutput(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

void main();
