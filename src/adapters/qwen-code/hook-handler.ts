import fs from "node:fs/promises";
import {
  QwenCodeGatewayClient,
  qwenCodeGatewayClientFromEnv,
} from "./gateway-client.js";
import {
  defaultQwenCodeStateDir,
  readQwenCodeCaptureState,
  writeQwenCodeCaptureState,
} from "./capture-state.js";
import { createQwenCodeSessionKey } from "./session-key.js";
import {
  getLatestCompletedQwenTurn,
  hashQwenCodeTurn,
} from "./transcript-parser.js";
import type {
  QwenCodeAdapterEnv,
  QwenCodeAdapterLogger,
  QwenCodeHookInput,
  QwenCodeHookOutput,
} from "./types.js";

export interface QwenCodeHookHandlerOptions {
  client?: QwenCodeGatewayClient;
  env?: QwenCodeAdapterEnv;
  logger?: QwenCodeAdapterLogger;
  stateDir?: string;
}

function allow(output?: Partial<QwenCodeHookOutput>): QwenCodeHookOutput {
  return {
    continue: true,
    decision: "allow",
    ...output,
  };
}

function formatRecallContext(context: string): string {
  return [
    "Relevant memory from TencentDB Agent Memory:",
    "",
    context.trim(),
  ].join("\n");
}

function resolveSessionKey(input: QwenCodeHookInput, env: QwenCodeAdapterEnv): string {
  return createQwenCodeSessionKey({
    cwd: input.cwd,
    sessionId: input.session_id,
    explicitSessionKey: env["TDAI_SESSION_KEY"] ?? env["MEMORY_TENCENTDB_SESSION_KEY"],
  });
}

export async function handleQwenCodeHook(
  input: QwenCodeHookInput,
  options: QwenCodeHookHandlerOptions = {},
): Promise<QwenCodeHookOutput> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const client = options.client ?? qwenCodeGatewayClientFromEnv(env);
  const sessionKey = resolveSessionKey(input, env);

  try {
    switch (input.hook_event_name) {
      case "SessionStart":
        await client.health();
        return allow();

      case "UserPromptSubmit": {
        const query = typeof input.prompt === "string" ? input.prompt.trim() : "";
        if (!query) return allow();
        const result = await client.recall({
          query,
          session_key: sessionKey,
          user_id: env["TDAI_USER_ID"] ?? env["MEMORY_TENCENTDB_USER_ID"],
        });
        if (!result.context?.trim()) return allow();
        return allow({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: formatRecallContext(result.context),
          },
        });
      }

      case "Stop": {
        if (!input.transcript_path) return allow();
        const rawTranscript = await fs.readFile(input.transcript_path, "utf8");
        const turn = getLatestCompletedQwenTurn(rawTranscript);
        if (!turn) return allow();

        const turnHash = hashQwenCodeTurn(turn);
        const stateDir = options.stateDir ?? env["TDAI_QWEN_ADAPTER_STATE_DIR"] ?? defaultQwenCodeStateDir();
        const state = await readQwenCodeCaptureState(stateDir, sessionKey);
        if (state.lastCapturedTurnHash === turnHash) return allow();

        await client.capture({
          user_content: turn.userText,
          assistant_content: turn.assistantText,
          session_key: sessionKey,
          session_id: input.session_id,
          user_id: env["TDAI_USER_ID"] ?? env["MEMORY_TENCENTDB_USER_ID"],
          messages: [
            { role: "user", content: turn.userText },
            { role: "assistant", content: turn.assistantText },
          ],
        });
        await writeQwenCodeCaptureState(stateDir, sessionKey, {
          lastCapturedTurnHash: turnHash,
        });
        return allow();
      }

      case "SessionEnd":
        await client.endSession({
          session_key: sessionKey,
          user_id: env["TDAI_USER_ID"] ?? env["MEMORY_TENCENTDB_USER_ID"],
        });
        return allow();

      default:
        return allow();
    }
  } catch (err) {
    logger.warn?.(
      `[tdai-qwen-code] ${input.hook_event_name} failed open: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return allow();
  }
}

