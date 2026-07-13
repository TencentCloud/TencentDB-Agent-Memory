import * as fs from "node:fs";
import type {
  CaptureResult,
  MemoryPlatformAdapter,
  PromptCache,
  RecallResult,
} from "../../../src/adapters/adapter-sdk/index.js";

interface ClaudeCodeBaseEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

interface ClaudeCodeRecallEvent extends ClaudeCodeBaseEvent {
  prompt?: string;
}

interface ClaudeCodeCaptureEvent extends ClaudeCodeBaseEvent {
  last_assistant_message?: string | null;
  assistant_response?: string | null;
}

interface ClaudeCodeRecallOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

interface ClaudeCodeCaptureOutput {
  continue: boolean;
}

interface TranscriptTurn {
  userText?: string;
  assistantText?: string;
}

export const claudeCodeMemoryAdapter: MemoryPlatformAdapter<
  ClaudeCodeRecallEvent,
  ClaudeCodeCaptureEvent,
  ClaudeCodeRecallOutput,
  ClaudeCodeCaptureOutput
> = {
  platform: "claudecode",

  parseRecall(event: ClaudeCodeRecallEvent, cache: PromptCache) {
    const sessionKey = event.session_id;
    const prompt = event.prompt;
    if (!sessionKey || !prompt) return null;

    cache.set(sessionKey, prompt);
    return {
      query: prompt,
      session_key: sessionKey,
    };
  },

  formatRecall(result: RecallResult): ClaudeCodeRecallOutput {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.context ?? "",
      },
    };
  },

  parseCapture(event: ClaudeCodeCaptureEvent, cache: PromptCache) {
    const sessionKey = event.session_id;
    if (!sessionKey) return null;

    const transcriptTurn = readLatestTranscriptTurn(event.transcript_path);
    const userContent = cache.get(sessionKey) ?? transcriptTurn.userText;
    const assistantContent =
      event.last_assistant_message ??
      event.assistant_response ??
      transcriptTurn.assistantText;

    if (!userContent || !assistantContent) return null;

    return {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
    };
  },

  formatCapture(_result: CaptureResult): ClaudeCodeCaptureOutput {
    return { continue: true };
  },
};

function readLatestTranscriptTurn(transcriptPath: string | undefined): TranscriptTurn {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

  let userText: string | undefined;
  let assistantText: string | undefined;

  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;

      const entry = JSON.parse(line) as Record<string, unknown>;
      const message = readRecord(entry.message);
      const role = readString(message?.role) ?? readString(entry.role);
      const content = normalizeContent(message?.content ?? entry.content);

      if (!content) continue;
      if (role === "user") userText = content;
      if (role === "assistant") assistantText = content;
    }
  } catch {
    return {};
  }

  return { userText, assistantText };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;

  const text = value
    .map((part) => {
      if (typeof part === "string") return part;
      const record = readRecord(part);
      return readString(record?.text);
    })
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .trim();

  return text || undefined;
}
