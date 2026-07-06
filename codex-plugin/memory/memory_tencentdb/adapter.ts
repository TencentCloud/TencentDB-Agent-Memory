import type {
  CaptureResult,
  MemoryPlatformAdapter,
  PromptCache,
  RecallResult,
} from "../../../src/adapters/adapter-sdk/index.js";

interface CodexBaseEvent {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
}

interface CodexRecallEvent extends CodexBaseEvent {
  prompt?: string;
}

interface CodexCaptureEvent extends CodexBaseEvent {
  last_assistant_message?: string | null;
}

interface CodexRecallOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

interface CodexCaptureOutput {
  continue: boolean;
}

export const codexMemoryAdapter: MemoryPlatformAdapter<
  CodexRecallEvent,
  CodexCaptureEvent,
  CodexRecallOutput,
  CodexCaptureOutput
> = {
  platform: "codex",

  parseRecall(event: CodexRecallEvent, cache: PromptCache) {
    const sessionKey = event.session_id;
    const prompt = event.prompt;
    if (!sessionKey || !prompt) return null;

    cache.set(sessionKey, prompt);
    return {
      query: prompt,
      session_key: sessionKey,
    };
  },

  formatRecall(result: RecallResult): CodexRecallOutput {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.context ?? "",
      },
    };
  },

  parseCapture(event: CodexCaptureEvent, cache: PromptCache) {
    const sessionKey = event.session_id;
    const assistantContent = event.last_assistant_message;
    if (!sessionKey || !assistantContent) return null;

    const userContent = cache.get(sessionKey);
    if (!userContent) return null;

    return {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
    };
  },

  formatCapture(_result: CaptureResult): CodexCaptureOutput {
    return { continue: true };
  },
};
