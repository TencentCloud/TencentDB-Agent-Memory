import type { RecallResult } from "../../core/types.js";
import type { DynamicContextPlacement } from "../../config.js";
import {
  stripRelevantMemoriesFromMessageContent,
} from "../../utils/sanitize.js";

export interface OpenClawRecallHookResult extends RecallResult {
  /** Dynamic recall appended after the user prompt when the host supports it. */
  appendContext?: string;
}

export interface StripInjectedRecallResult<TMessage extends { role?: string; content?: unknown }> {
  message: TMessage;
  strippedChars: number;
  contentType: "string" | "parts";
}

/**
 * Shape core recall output for OpenClaw's prompt-build hook.
 *
 * The core always puts dynamic L1 recall in prependContext as the
 * host-neutral default. When dynamicContextPlacement is "append", this
 * adapter moves it to appendContext so the user-prompt prefix stays
 * stable for OpenAI-compatible prefix-matching cache providers.
 */
export function shapeOpenClawRecallResult(
  result: RecallResult | undefined,
  injectionMode: DynamicContextPlacement,
): OpenClawRecallHookResult | undefined {
  if (!result) return undefined;
  if (injectionMode !== "append" || !result.prependContext) {
    return result;
  }

  const { prependContext, ...rest } = result;
  return {
    ...rest,
    appendContext: prependContext,
  };
}

/**
 * Remove injected recall artifacts before user messages are persisted.
 *
 * The current-turn LLM has already seen the full prompt by the time
 * before_message_write runs. Keeping the block in history would replay
 * stale dynamic recall and grow the prompt prefix over time.
 *
 * When showInjected is true, the injected block is preserved for
 * debugging and traceability.
 */
export function stripInjectedRecallFromMessage<TMessage extends { role?: string; content?: unknown }>(
  message: TMessage,
  showInjected: boolean,
): StripInjectedRecallResult<TMessage> | undefined {
  if (showInjected || message.role !== "user") return undefined;

  const cleaned = stripRelevantMemoriesFromMessageContent(message.content, { trim: true });
  if (!cleaned.changed) return undefined;

  const contentType = typeof message.content === "string" ? "string" as const : "parts" as const;
  return {
    message: { ...message, content: cleaned.content },
    strippedChars: cleaned.removedChars,
    contentType,
  };
}
