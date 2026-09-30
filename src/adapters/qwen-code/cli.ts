#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { handleQwenCodeHook } from "./hook-handler.js";
import type { QwenCodeHookInput } from "./types.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runQwenCodeHookCli(): Promise<void> {
  let input: QwenCodeHookInput;
  try {
    input = JSON.parse(await readStdin()) as QwenCodeHookInput;
  } catch {
    stdout.write(JSON.stringify({ continue: true, decision: "allow" }));
    return;
  }

  const output = await handleQwenCodeHook(input);
  stdout.write(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runQwenCodeHookCli().catch((err) => {
    console.error(`[tdai-qwen-code] unexpected hook error: ${err instanceof Error ? err.message : String(err)}`);
    stdout.write(JSON.stringify({ continue: true, decision: "allow" }));
  });
}
