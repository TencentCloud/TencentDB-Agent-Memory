/**
 * Gemini CLI hook handler for TencentDB Agent Memory.
 *
 * Maps Gemini CLI lifecycle events to TdaiCore capabilities exposed by the
 * TDAI Gateway: recall before a turn, capture after a turn, and flush when
 * the session ends. All failures are fail-open so a memory outage never
 * blocks normal Gemini CLI usage.
 */

import type { TdaiGatewayClientLike } from "./gateway-client.js";

export interface GeminiHookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  timestamp?: string;
  prompt?: string;
  prompt_response?: string;
  source?: string;
  [key: string]: unknown;
}

export interface GeminiHookOutput {
  systemMessage?: string;
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

export interface GeminiHookLogger {
  error(message: string): void;
}

const defaultLogger: GeminiHookLogger = {
  error(message: string) {
    process.stderr.write(`[memory-tencentdb-gemini] ${message}\n`);
  },
};

/**
 * Handle one Gemini CLI hook event.
 *
 * Returns a valid hook output object in every branch. Never throws; memory
 * adapter errors are logged to stderr and degrade to an empty output.
 */
export async function handleGeminiCliHook(
  input: GeminiHookInput,
  client: TdaiGatewayClientLike,
  logger: GeminiHookLogger = defaultLogger,
): Promise<GeminiHookOutput> {
  const event = input.hook_event_name ?? "";
  const sessionKey = input.session_id?.trim() || "gemini-cli";

  try {
    switch (event) {
      case "BeforeAgent": {
        const prompt = input.prompt?.trim() ?? "";
        if (!prompt) return {};
        const result = await client.recall({ query: prompt, sessionKey });
        const context = result.context?.trim() ?? "";
        if (!context) return {};
        return {
          hookSpecificOutput: {
            additionalContext: context,
          },
        };
      }
      case "AfterAgent": {
        const userText = input.prompt?.trim() ?? "";
        const assistantText = input.prompt_response?.trim() ?? "";
        if (!userText || !assistantText) return {};
        await client.capture({
          userContent: userText,
          assistantContent: assistantText,
          sessionKey,
          sessionId: sessionKey,
        });
        return {};
      }
      case "SessionEnd": {
        await client.endSession({ sessionKey });
        return {};
      }
      default:
        return {};
    }
  } catch (err) {
    logger.error(`hook ${event} failed (fail-open): ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
