import type { AdapterRuntime, PlatformAdapter } from "../sdk/types.js";
import type { CodexHookInput, CodexHookOutput } from "./hooks.js";
import { CodexSessionState, codexSessionKey } from "./session.js";

export type CodexHookHandler = (input: CodexHookInput) => Promise<CodexHookOutput>;

export interface CodexPlatformAdapterOptions {
  stateDir?: string;
}

export class CodexPlatformAdapter implements PlatformAdapter<CodexHookHandler> {
  readonly platform = "codex";

  constructor(private readonly options: CodexPlatformAdapterOptions = {}) {}

  create(runtime: AdapterRuntime): CodexHookHandler {
    const state = new CodexSessionState(this.options.stateDir);

    return async (input) => {
      if (input.hook_event_name === "UserPromptSubmit") {
        await state.savePrompt(input.session_id, input.turn_id, input.prompt);
        const result = await runtime.recall({
          query: input.prompt,
          sessionKey: codexSessionKey(input.session_id),
        });
        if (!result?.context) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `<relevant-memories>\n${result.context}\n</relevant-memories>`,
          },
        };
      }

      if (input.stop_hook_active || !input.last_assistant_message?.trim()) return {};

      const promptRecord = await state.getPromptRecord(input.session_id, input.turn_id);
      if (!promptRecord || !await state.beginCapture(input.session_id, input.turn_id)) return {};

      const result = await runtime.capture({
        operationId: input.turn_id,
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
      if (result) await state.markCaptured(input.session_id, input.turn_id);
      else await state.releaseCapture(input.session_id, input.turn_id);
      return {};
    };
  }
}