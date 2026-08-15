/**
 * Claude Code platform binding.
 *
 * Maps Claude Code's hook payloads to the SDK's normalized inputs:
 *   - UserPromptSubmit → recall   (inject memories as additionalContext)
 *   - Stop             → capture   (read last turn from the transcript)
 *   - SessionEnd       → flush
 *
 * Hook JSON reference: https://docs.claude.com/en/docs/claude-code/hooks
 *
 * This is the ONLY file needed to teach the SDK how to speak "Claude Code".
 * Everything else (HTTP, error handling, tools) comes from the SDK core.
 */

import fs from "node:fs";
import type {
  PlatformBinding,
  RecallInput,
  RecallOutput,
  CaptureInput,
  SessionEndInput,
} from "../../src/types.js";

// ============================
// Claude Code hook payload shapes (subset we use)
// ============================

export interface UserPromptSubmitPayload {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  prompt: string;
}

export interface StopPayload {
  hook_event_name: "Stop";
  session_id: string;
  transcript_path: string;
  stop_hook_active?: boolean;
}

export interface SessionEndPayload {
  hook_event_name: "SessionEnd";
  session_id: string;
  transcript_path?: string;
  reason?: string;
}

/** UserPromptSubmit output that injects recalled memories into the prompt. */
export interface UserPromptSubmitOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

// ============================
// Binding
// ============================

export interface ClaudeCodeBindingOptions {
  /** Fixed user id (usually from env). */
  userId?: string;
}

export class ClaudeCodeBinding
  implements
    PlatformBinding<
      UserPromptSubmitPayload,
      StopPayload,
      SessionEndPayload,
      UserPromptSubmitOutput | null
    >
{
  readonly platform = "claude-code";
  // Claude Code surfaces tools via an MCP server; namespacing is handled by
  // Claude Code itself (mcp__<server>__<tool>), so plain names are fine here.
  readonly toolNames = {
    memory_search: "memory_search",
    conversation_search: "conversation_search",
  } as const;

  private readonly userId?: string;

  constructor(opts: ClaudeCodeBindingOptions = {}) {
    this.userId = opts.userId;
  }

  // -- recall -------------------------------------------------------------

  parseRecall(raw: UserPromptSubmitPayload): RecallInput | null {
    const query = (raw?.prompt ?? "").trim();
    if (!query) return null;
    const sessionKey = raw.session_id;
    if (!sessionKey) return null;
    return { query, sessionKey, userId: this.userId };
  }

  formatRecall(result: RecallOutput, _raw: UserPromptSubmitPayload): UserPromptSubmitOutput | null {
    if (!result.context) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `## TencentDB Agent Memory\n${result.context}`,
      },
    };
  }

  // -- capture ------------------------------------------------------------

  parseCapture(raw: StopPayload): CaptureInput | null {
    const sessionKey = raw?.session_id;
    if (!sessionKey || !raw.transcript_path) return null;

    const turn = readLastTurn(raw.transcript_path);
    if (!turn || (!turn.user && !turn.assistant)) return null;

    return {
      userContent: turn.user,
      assistantContent: turn.assistant,
      sessionKey,
      userId: this.userId,
    };
  }

  // -- session end --------------------------------------------------------

  parseSessionEnd(raw: SessionEndPayload): SessionEndInput | null {
    const sessionKey = raw?.session_id;
    if (!sessionKey) return null;
    return { sessionKey, userId: this.userId };
  }
}

// ============================
// Transcript parsing
// ============================

interface LastTurn {
  user: string;
  assistant: string;
}

/**
 * Read the most recent user+assistant exchange from a Claude Code transcript.
 *
 * The transcript is JSONL; each line is an object with a `type` ("user" |
 * "assistant" | ...) and a `message: { role, content }` where content is
 * either a string or an array of content blocks. We scan from the end to find
 * the last assistant message, then the closest preceding user message.
 */
export function readLastTurn(transcriptPath: string): LastTurn | null {
  let content: string;
  try {
    content = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let assistant = "";
  let user = "";
  let assistantIdx = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = safeParse(lines[i]!);
    if (!entry) continue;
    if (entry.type === "assistant" && !assistant) {
      assistant = extractText(entry.message);
      assistantIdx = i;
      break;
    }
  }

  const from = assistantIdx >= 0 ? assistantIdx : lines.length;
  for (let i = from - 1; i >= 0; i--) {
    const entry = safeParse(lines[i]!);
    if (!entry) continue;
    if (entry.type === "user") {
      user = extractText(entry.message);
      if (user) break;
    }
  }

  if (!user && !assistant) return null;
  return { user, assistant };
}

interface TranscriptEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function safeParse(line: string): TranscriptEntry | null {
  try {
    return JSON.parse(line) as TranscriptEntry;
  } catch {
    return null;
  }
}

/** Extract plain text from a message whose content is string or block array. */
function extractText(message: { content?: unknown } | undefined): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          return String((block as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}
