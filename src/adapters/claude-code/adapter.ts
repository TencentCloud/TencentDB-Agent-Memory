import type { AdapterRuntime, PlatformAdapter } from "../sdk/types.js";
import type { ClaudeCodeHookInput, ClaudeCodeHookOutput } from "./hooks.js";
import { ClaudeCodeSessionState, claudeCodeSessionKey } from "./session.js";

export type ClaudeCodeHookHandler = (input: ClaudeCodeHookInput) => Promise<ClaudeCodeHookOutput>;

export interface ClaudeCodePlatformAdapterOptions {
  stateDir?: string;
}

export class ClaudeCodePlatformAdapter implements PlatformAdapter<ClaudeCodeHookHandler> {
  readonly platform = "claude-code";

  constructor(private readonly options: ClaudeCodePlatformAdapterOptions = {}) {}

  create(runtime: AdapterRuntime): ClaudeCodeHookHandler {
    const state = new ClaudeCodeSessionState(this.options.stateDir);

    return async (input) => {
      if (input.hook_event_name === "UserPromptSubmit") {
        if (input.prompt_id) await state.savePrompt(input.session_id, input.prompt_id, input.prompt);
        else await state.saveLatestPrompt(input.session_id, input.prompt);

        const result = await runtime.recall({
          query: input.prompt,
          sessionKey: claudeCodeSessionKey(input.session_id),
        });
        if (!result?.context) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `<relevant-memories>\n${result.context}\n</relevant-memories>`,
          },
        };
      }

      if (input.hook_event_name === "SessionEnd") {
        await runtime.endSession({
          operationId: input.session_id,
          sessionKey: claudeCodeSessionKey(input.session_id),
        });
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

      const result = await runtime.capture({
        operationId: promptId,
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
      if (result) await state.markCaptured(input.session_id, promptId);
      else await state.releaseCapture(input.session_id, promptId);
      return {};
    };
  }
}