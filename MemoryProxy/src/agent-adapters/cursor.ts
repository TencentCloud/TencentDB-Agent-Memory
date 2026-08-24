/**
 * Cursor Agent adapter.
 *
 * Phase 0B capture (2026-08-24) confirmed that Cursor reaches an Override Base
 * URL through OpenAI Chat Completions (`POST /v1/chat/completions`) with
 * `messages`, `tools`, streaming enabled, and the native `AskQuestion` tool.
 * No stable conversation header was observed. Unknown request shapes therefore
 * fail open and are passed through without session/injection side effects.
 */

import type { AgentAdapter, RequestKind } from "./types.js";

const REASONING_PLACEHOLDER = "[proxy cursor tool-call replay]";

/**
 * Cursor drops the non-standard `reasoning_content` field when it replays an
 * assistant tool-call message. DeepSeek thinking-mode rejects that history.
 * Repair only the affected Cursor assistant messages immediately after body
 * parsing; preserve any real non-empty reasoning_content already supplied.
 */
export function repairCursorReasoningContent(body: Record<string, unknown>): number {
  if (!Array.isArray(body.messages)) return 0;
  let repaired = 0;
  for (const raw of body.messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) continue;
    message.reasoning_content = REASONING_PLACEHOLDER;
    repaired += 1;
  }
  return repaired;
}

function extractCursorUserText(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;

  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.length > 0) {
      return candidate.text;
    }
  }
  return null;
}

export const cursorAdapter: AgentAdapter = {
  agentKind: "cursor",

  classifyRequest(body: Record<string, unknown>): RequestKind {
    // The only confirmed main-request invariant is an OpenAI messages array.
    // Do not guess at title/compaction signatures until real fixtures exist.
    if (Array.isArray(body.messages) && body.messages.length > 0) return "main";
    // RequestKind predates an explicit unknown variant. `auxiliary` is the
    // established no-side-effect passthrough path; handler logs it as unknown
    // specifically for Cursor.
    return "auxiliary";
  },

  extractUserText(content: unknown): string | null {
    return extractCursorUserText(content);
  },
};
