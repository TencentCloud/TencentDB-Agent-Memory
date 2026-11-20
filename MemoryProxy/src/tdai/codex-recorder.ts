import { codexAdapter } from "../agent-adapters/codex.js";
import type { TdaiMessage } from "./types.js";

const CONTINUATION_TYPES = new Set([
  "function_call", "function_call_output",
  "custom_tool_call", "custom_tool_call_output", "reasoning",
]);

/**
 * Responses requests replay conversation history on every tool round. A user
 * message preceding assistant/tool output belongs to an earlier request, so it
 * must not be archived again. Use message order, not text equality: a later
 * user turn is allowed to repeat exactly the same question.
 *
 * This is stateless so replicas and proxy restarts make the same decision.
 * It does not provide idempotency for retries of an identical initial request.
 */
export function extractNewCodexUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (item.role === "assistant" || CONTINUATION_TYPES.has(item.type)) return null;
    if (item.type === "message" && item.role === "user") {
      const content = codexAdapter.extractUserText([item])?.trim();
      return content ? { role: "user", content } : null;
    }
  }
  return null;
}
