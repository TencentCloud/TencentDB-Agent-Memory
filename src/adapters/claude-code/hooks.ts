import { createMemoryTools, type MemoryTools } from "../mcp/tools.js";
import { ClaudeCodeSessionState, claudeCodeSessionKey } from "./session.js";

export interface ClaudeCodeUserPromptSubmitInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt_id?: string;
  cwd: string;
  prompt: string;
}

export interface ClaudeCodeStopInput {
  hook_event_name: "Stop";
  session_id: string;
  prompt_id?: string;
  cwd: string;
  stop_hook_active: boolean;
  last_assistant_message: string | null;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

export interface ClaudeCodeSessionEndInput {
  hook_event_name: "SessionEnd";
  session_id: string;
  cwd: string;
  reason: string;
}

export type ClaudeCodeHookInput =
  | ClaudeCodeUserPromptSubmitInput
  | ClaudeCodeStopInput
  | ClaudeCodeSessionEndInput;

export type ClaudeCodeHookOutput = Record<string, unknown>;

export interface ClaudeCodeHookOptions {
  stateDir?: string;
  tools?: MemoryTools;
  log?: (message: string) => void;
}

export async function handleClaudeCodeHook(
  input: ClaudeCodeHookInput,
  options: ClaudeCodeHookOptions = {},
): Promise<ClaudeCodeHookOutput> {
  const state = new ClaudeCodeSessionState(options.stateDir);
  const tools = options.tools ?? createMemoryTools();
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][claude-code] ${message}\n`));

  if (input.hook_event_name === "UserPromptSubmit") {
    if (input.prompt_id) {
      await state.savePrompt(input.session_id, input.prompt_id, input.prompt);
    } else {
      await state.saveLatestPrompt(input.session_id, input.prompt);
    }
    try {
      const result = await tools.recall({
        query: input.prompt,
        sessionKey: claudeCodeSessionKey(input.session_id),
      });
      if (!result.context.trim()) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<relevant-memories>\n${result.context.trim()}\n</relevant-memories>`,
        },
      };
    } catch (error) {
      log(`MCP recall failed open: ${errorMessage(error)}`);
      return {};
    }
  }

  if (input.hook_event_name === "SessionEnd") {
    try {
      await tools.endSession({ sessionKey: claudeCodeSessionKey(input.session_id) });
    } catch (error) {
      log(`MCP session end failed open: ${errorMessage(error)}`);
    }
    return {};
  }

  if (
    input.stop_hook_active
    || !input.last_assistant_message?.trim()
    || (input.background_tasks?.length ?? 0) > 0
    || (input.session_crons?.length ?? 0) > 0
  ) return {};

  const promptRecord = input.prompt_id
    ? await state.getPromptRecord(input.session_id, input.prompt_id)
    : await state.getLatestPromptRecord(input.session_id);
  if (!promptRecord) return {};
  const promptId = promptRecord.promptId;
  if (!await state.beginCapture(input.session_id, promptId)) return {};

  try {
    await tools.capture({
      userContent: promptRecord.prompt,
      assistantContent: input.last_assistant_message,
      sessionKey: claudeCodeSessionKey(input.session_id),
      sessionId: input.session_id,
      messages: [
        {
          id: `claude-code:${input.session_id}:${promptId}:user`,
          role: "user",
          content: promptRecord.prompt,
        },
        {
          id: `claude-code:${input.session_id}:${promptId}:assistant`,
          role: "assistant",
          content: input.last_assistant_message,
        },
      ],
    });
    await state.markCaptured(input.session_id, promptId);
  } catch (error) {
    await state.releaseCapture(input.session_id, promptId);
    log(`MCP capture failed open: ${errorMessage(error)}`);
  }
  return {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}