/**
 * Codex CLI platform binding — a MINIMAL example.
 *
 * The purpose of this file is to prove the SDK's core claim: adding a new
 * Agent platform only requires implementing ONE interface (`PlatformBinding`).
 * Compare its size to `claude-code/binding.ts` — the SDK core (HTTP, error
 * handling, tools) is shared and never re-implemented.
 *
 * Codex integration points:
 *   - Capture: Codex's `notify` program is invoked on turn completion with a
 *     single JSON argv describing the turn (`agent-turn-complete`). We map that
 *     to a capture. See codex `notify` docs.
 *   - Tools:   Codex supports MCP servers via `~/.codex/config.toml`; reuse the
 *     generic MCP server pattern (see README) — tool exposure is binding
 *     agnostic, driven by MemoryAdapter.listTools()/handleToolCall().
 *   - Recall:  Codex has no pre-prompt hook, so recall is surfaced as the
 *     `memory_search` MCP tool instead of an automatic injection.
 */

import type {
  PlatformBinding,
  RecallInput,
  RecallOutput,
  CaptureInput,
  SessionEndInput,
} from "../../src/types.js";

/** Codex `notify` payload for a completed turn (subset). */
export interface CodexTurnCompletePayload {
  type: string; // "agent-turn-complete"
  "turn-id"?: string;
  "input-messages"?: string[];
  "last-assistant-message"?: string;
}

export interface CodexBindingOptions {
  userId?: string;
  /** Stable session key (Codex notify has no session id; supply from env). */
  sessionKey?: string;
}

export class CodexBinding
  implements PlatformBinding<{ query?: string; sessionKey?: string }, CodexTurnCompletePayload, unknown>
{
  readonly platform = "codex";
  readonly toolNames = {
    memory_search: "memory_search",
    conversation_search: "conversation_search",
  } as const;

  private readonly userId?: string;
  private readonly sessionKey: string;

  constructor(opts: CodexBindingOptions = {}) {
    this.userId = opts.userId;
    this.sessionKey = opts.sessionKey ?? "codex-session";
  }

  parseRecall(raw: { query?: string; sessionKey?: string }): RecallInput | null {
    const query = (raw?.query ?? "").trim();
    if (!query) return null;
    return { query, sessionKey: raw.sessionKey ?? this.sessionKey, userId: this.userId };
  }

  formatRecall(result: RecallOutput): string {
    return result.context;
  }

  parseCapture(raw: CodexTurnCompletePayload): CaptureInput | null {
    if (raw?.type !== "agent-turn-complete") return null;
    const userContent = (raw["input-messages"] ?? []).join("\n").trim();
    const assistantContent = (raw["last-assistant-message"] ?? "").trim();
    if (!userContent && !assistantContent) return null;
    return {
      userContent,
      assistantContent,
      sessionKey: raw["turn-id"] ? this.sessionKey : this.sessionKey,
      userId: this.userId,
    };
  }

  parseSessionEnd(): SessionEndInput | null {
    // Codex has no session-end event; flush is a no-op for this binding.
    return null;
  }
}
