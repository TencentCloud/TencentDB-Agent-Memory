import { pathToFileURL } from "node:url";
import { loadClaudeCodeAdapterConfig } from "../config.js";
import { formatClaudeCodeAdditionalContext } from "../context-format.js";
import { TdaiGatewayClient } from "../gateway-client.js";
import { deriveClaudeCodeSessionKey } from "../session-key.js";
import { readActiveShortTermCanvas } from "../short-term/store.js";
import type {
  ClaudeCodeHookInput,
  ClaudeCodeUserPromptSubmitOutput,
  RecallResponse,
} from "../types.js";

function extractPrompt(input: ClaudeCodeHookInput): string {
  return (
    input.prompt ||
    input.user_prompt ||
    input.message?.content ||
    ""
  ).trim();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handleUserPromptSubmit(
  input: ClaudeCodeHookInput,
  options?: {
    client?: Pick<TdaiGatewayClient, "recall">;
    env?: NodeJS.ProcessEnv;
    shortTermCanvas?: string;
  },
): Promise<ClaudeCodeUserPromptSubmitOutput> {
  const config = loadClaudeCodeAdapterConfig(options?.env);
  const prompt = extractPrompt(input);
  if (!prompt) return {};

  const sessionKey = deriveClaudeCodeSessionKey({
    cwd: input.cwd,
    sessionId: input.session_id,
  });

  const shortTermCanvas = config.shortTermEnabled
    ? options?.shortTermCanvas ?? readActiveShortTermCanvas({
        storageDir: config.storageDir,
        cwd: input.cwd,
        sessionId: input.session_id,
      })
    : undefined;

  let recall: RecallResponse | undefined;
  if (config.autoRecall) {
    const client = options?.client ?? new TdaiGatewayClient({
      baseUrl: config.gatewayUrl,
      apiKey: config.gatewayApiKey,
    });

    try {
      recall = await client.recall({
        query: prompt,
        session_key: sessionKey,
      });
    } catch (err) {
      console.error(`[memory-tencentdb:claude-code] recall failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const additionalContext = formatClaudeCodeAdditionalContext({
    recall,
    shortTermCanvas,
    options: {
      recallMaxChars: config.recallMaxChars,
      canvasMaxChars: config.canvasMaxChars,
    },
  });

  return additionalContext
    ? {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      }
    : {};
}

export async function runUserPromptSubmitHook(): Promise<void> {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) as ClaudeCodeHookInput : {};
  const output = await handleUserPromptSubmit(input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUserPromptSubmitHook().catch((err) => {
    console.error(`[memory-tencentdb:claude-code] hook failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
