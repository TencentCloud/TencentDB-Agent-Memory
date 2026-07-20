import { createMemoryTools, type MemoryTools } from "../mcp/tools.js";
import { CodexSessionState, codexSessionKey } from "./session.js";

export interface CodexUserPromptSubmitInput {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  turn_id: string;
  cwd: string;
  prompt: string;
}

export interface CodexStopInput {
  hook_event_name: "Stop";
  session_id: string;
  turn_id: string;
  cwd: string;
  stop_hook_active: boolean;
  last_assistant_message: string | null;
}

export type CodexHookInput = CodexUserPromptSubmitInput | CodexStopInput;

export type CodexHookOutput = Record<string, unknown>;

export interface CodexHookOptions {
  stateDir?: string;
  tools?: MemoryTools;
  log?: (message: string) => void;
}

export async function handleCodexHook(
  input: CodexHookInput,
  options: CodexHookOptions = {},
): Promise<CodexHookOutput> {
  const state = new CodexSessionState(options.stateDir);
  const tools = options.tools ?? createMemoryTools();
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][codex] ${message}\n`));

  if (input.hook_event_name === "UserPromptSubmit") {
    await state.savePrompt(input.session_id, input.turn_id, input.prompt);
    try {
      const result = await tools.recall({
        query: input.prompt,
        sessionKey: codexSessionKey(input.session_id),
      });
      const context = result.context;
      if (!context.trim()) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<relevant-memories>\n${context.trim()}\n</relevant-memories>`,
        },
      };
    } catch (error) {
      log(`MCP recall failed open: ${errorMessage(error)}`);
      return {};
    }
  }

  if (input.stop_hook_active || !input.last_assistant_message?.trim()) return {};

  const promptRecord = await state.getPromptRecord(input.session_id, input.turn_id);
  if (!promptRecord) return {};
  if (!await state.beginCapture(input.session_id, input.turn_id)) return {};

  try {
    await tools.capture({
      userContent: promptRecord.prompt,
      assistantContent: input.last_assistant_message,
      sessionKey: codexSessionKey(input.session_id),
      sessionId: input.session_id,
      messages: [
        {
          id: `codex:${input.session_id}:${input.turn_id}:user`,
          role: "user",
          content: promptRecord.prompt,
        },
        {
          id: `codex:${input.session_id}:${input.turn_id}:assistant`,
          role: "assistant",
          content: input.last_assistant_message,
        },
      ],
    });
    await state.markCaptured(input.session_id, input.turn_id);
  } catch (error) {
    await state.releaseCapture(input.session_id, input.turn_id);
    log(`MCP capture failed open: ${errorMessage(error)}`);
  }
  return {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}