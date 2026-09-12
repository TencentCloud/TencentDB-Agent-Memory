import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadClaudeCodeAdapterConfig } from "../config.js";
import { TdaiGatewayClient } from "../gateway-client.js";
import { parseClaudeCodeTranscriptFile } from "../mappers/transcript.js";
import { deriveClaudeCodeSessionKey } from "../session-key.js";
import type { ClaudeCodeHookInput } from "../types.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handleSessionEnd(
  input: ClaudeCodeHookInput,
  options?: {
    client?: Pick<TdaiGatewayClient, "seed" | "sessionEnd">;
    env?: NodeJS.ProcessEnv;
  },
): Promise<Record<string, never>> {
  const config = loadClaudeCodeAdapterConfig(options?.env);
  const sessionKey = deriveClaudeCodeSessionKey({
    cwd: input.cwd,
    sessionId: input.session_id,
  });
  const client = options?.client ?? new TdaiGatewayClient({
    baseUrl: config.gatewayUrl,
    apiKey: config.gatewayApiKey,
  });

  try {
    if (typeof input.transcript_path === "string" && existsSync(input.transcript_path)) {
      const session = parseClaudeCodeTranscriptFile({
        transcriptPath: input.transcript_path,
        sessionKey,
        sessionId: input.session_id,
      });

      if (session.conversations.length > 0) {
        await client.seed({
          data: { sessions: [session] },
          session_key: sessionKey,
          strict_round_role: false,
          auto_fill_timestamps: true,
        });
      }
    } else {
      console.error("[memory-tencentdb:claude-code] SessionEnd transcript_path missing or unreadable; skipping /seed");
    }
  } catch (err) {
    console.error(`[memory-tencentdb:claude-code] SessionEnd seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await client.sessionEnd({ session_key: sessionKey });
  } catch (err) {
    console.error(`[memory-tencentdb:claude-code] SessionEnd flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {};
}

export async function runSessionEndHook(): Promise<void> {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) as ClaudeCodeHookInput : {};
  const output = await handleSessionEnd(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSessionEndHook().catch((err) => {
    console.error(`[memory-tencentdb:claude-code] SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
