import type { GatewayPlatformAdapter } from "../../../../src/adapters/gateway-client/index.js";
import { createClaudeCodeGatewayClient, createClaudeCodeMemoryAdapter } from "../adapter.js";
import { deletePrompt, readPrompt, writePrompt } from "../prompt-cache.js";
import { readLatestTranscriptTurn, type TranscriptTurn } from "../transcript.js";
import { isMainModule, readHookInput, writeHookOutput } from "./io.js";

export interface ClaudeCodeHookEvent {
  hook_event_name?: "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd";
  session_id?: string;
  prompt?: string;
  last_assistant_message?: string | null;
  assistant_response?: string | null;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

export interface ClaudeCodeRecallOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

export interface ClaudeCodeHookOutput {
  continue: boolean;
}

interface RecallHookDependencies {
  createAdapter: (sessionId: string) => Pick<GatewayPlatformAdapter, "prefetch">;
  writePrompt: (sessionId: string, prompt: string) => Promise<void>;
  logger: Pick<Console, "warn">;
}

const defaultRecallDependencies: RecallHookDependencies = {
  createAdapter: createClaudeCodeMemoryAdapter,
  writePrompt,
  logger: console,
};

export async function runRecallHook(
  event: ClaudeCodeHookEvent,
  deps: Partial<RecallHookDependencies> = {},
): Promise<ClaudeCodeRecallOutput> {
  const dependencies = { ...defaultRecallDependencies, ...deps };
  const sessionId = event.session_id?.trim();
  const prompt = event.prompt?.trim();
  if (!sessionId || !prompt) return {};

  try {
    await dependencies.writePrompt(sessionId, prompt);
  } catch (error) {
    dependencies.logger.warn(`[tdai-claude] Failed to cache prompt: ${String(error)}`);
  }

  let additionalContext = "";
  try {
    const recalled = await dependencies.createAdapter(sessionId).prefetch(prompt);
    additionalContext = recalled.context ?? "";
  } catch (error) {
    dependencies.logger.warn(`[tdai-claude] Recall failed: ${String(error)}`);
  }

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

interface CaptureHookDependencies {
  createAdapter: (sessionId: string) => Pick<GatewayPlatformAdapter, "captureTurn">;
  readPrompt: (sessionId: string) => Promise<string | null>;
  deletePrompt: (sessionId: string) => Promise<void>;
  readTranscript: (transcriptPath: string) => Promise<TranscriptTurn | null>;
  logger: Pick<Console, "warn">;
}

const defaultCaptureDependencies: CaptureHookDependencies = {
  createAdapter: createClaudeCodeMemoryAdapter,
  readPrompt,
  deletePrompt,
  readTranscript: readLatestTranscriptTurn,
  logger: console,
};

export async function runCaptureHook(
  event: ClaudeCodeHookEvent,
  deps: Partial<CaptureHookDependencies> = {},
): Promise<ClaudeCodeHookOutput> {
  const dependencies = { ...defaultCaptureDependencies, ...deps };
  const sessionId = event.session_id?.trim();
  if (!sessionId || event.stop_hook_active) return { continue: true };

  let cachedPrompt: string | null;
  try {
    cachedPrompt = await dependencies.readPrompt(sessionId);
  } catch (error) {
    dependencies.logger.warn(`[tdai-claude] Prompt cache read failed: ${String(error)}`);
    return { continue: true };
  }

  const eventAssistant = event.last_assistant_message?.trim() ||
    event.assistant_response?.trim() || "";
  let transcript: TranscriptTurn | null = null;
  if ((!cachedPrompt || !eventAssistant) && event.transcript_path) {
    try {
      transcript = await dependencies.readTranscript(event.transcript_path);
    } catch (error) {
      dependencies.logger.warn(`[tdai-claude] Transcript read failed: ${String(error)}`);
      return { continue: true };
    }
  }

  const userText = cachedPrompt ?? transcript?.userText ?? "";
  const assistantText = eventAssistant || transcript?.assistantText || "";
  if (!userText || !assistantText) return { continue: true };

  try {
    await dependencies.createAdapter(sessionId).captureTurn({ userText, assistantText });
    await dependencies.deletePrompt(sessionId);
  } catch (error) {
    dependencies.logger.warn(`[tdai-claude] Capture failed: ${String(error)}`);
  }

  return { continue: true };
}

interface SessionStartDependencies {
  health: () => Promise<unknown>;
  logger: Pick<Console, "warn">;
}

const defaultSessionStartDependencies: SessionStartDependencies = {
  health: () => createClaudeCodeGatewayClient().health(),
  logger: console,
};

export async function runSessionStartHook(
  _event: ClaudeCodeHookEvent,
  deps: Partial<SessionStartDependencies> = {},
): Promise<ClaudeCodeHookOutput> {
  const dependencies = { ...defaultSessionStartDependencies, ...deps };
  try {
    await dependencies.health();
  } catch (error) {
    dependencies.logger.warn(`[tdai-claude] Gateway health check failed: ${String(error)}`);
  }
  return { continue: true };
}

interface SessionEndDependencies {
  createAdapter: (sessionId: string) => Pick<GatewayPlatformAdapter, "endSession">;
  logger: Pick<Console, "warn">;
}

const defaultSessionEndDependencies: SessionEndDependencies = {
  createAdapter: createClaudeCodeMemoryAdapter,
  logger: console,
};

export async function runSessionEndHook(
  event: ClaudeCodeHookEvent,
  deps: Partial<SessionEndDependencies> = {},
): Promise<ClaudeCodeHookOutput> {
  const dependencies = { ...defaultSessionEndDependencies, ...deps };
  const sessionId = event.session_id?.trim();
  if (!sessionId) return { continue: true };

  try {
    await dependencies.createAdapter(sessionId).endSession();
  } catch (error) {
    dependencies.logger.warn(`[tdai-claude] Session end failed: ${String(error)}`);
  }
  return { continue: true };
}

export async function runClaudeCodeHook(event: ClaudeCodeHookEvent): Promise<ClaudeCodeRecallOutput | ClaudeCodeHookOutput> {
  switch (event.hook_event_name) {
    case "SessionStart":
      return runSessionStartHook(event);
    case "UserPromptSubmit":
      return runRecallHook(event);
    case "Stop":
      return runCaptureHook(event);
    case "SessionEnd":
      return runSessionEndHook(event);
    default:
      return { continue: true };
  }
}

if (isMainModule(import.meta.url)) {
  await writeHookOutput(await runClaudeCodeHook(await readHookInput<ClaudeCodeHookEvent>()));
}
