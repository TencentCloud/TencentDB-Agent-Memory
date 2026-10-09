import { handleClaudeCodeHook, type ClaudeCodeHookInput } from "./hooks.js";

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as ClaudeCodeHookInput;
    const output = await handleClaudeCodeHook(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`[memory-tencentdb][claude-code] Hook failed open: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write("{}\n");
  }
}

void main();