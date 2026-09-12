import type { RecallResult } from "../../core/types.js";
import type { RecallInjectionMode } from "../../config.js";

export interface OpenClawRecallHookResult extends RecallResult {
  /** Dynamic recall appended after the user prompt when the host supports it. */
  appendContext?: string;
}

export type MessageContentPart = Record<string, unknown>;

export interface StripInjectedRecallResult<TMessage extends { role?: string; content?: unknown }> {
  message: TMessage;
  strippedChars: number;
  contentType: "string" | "parts";
}

const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

/**
 * Shape core recall output for OpenClaw's prompt-build hook.
 *
 * Core keeps dynamic L1 recall in `prependContext` because not every host has
 * an append hook field. OpenClaw does, so `append` mode lets users keep
 * dynamic recall out of the prompt prefix for prefix-matching cache providers.
 */
export function shapeOpenClawRecallResult(
  result: RecallResult | undefined,
  injectionMode: RecallInjectionMode,
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
 * Remove dynamic recall artifacts before user messages are persisted.
 *
 * The current model call has already seen the injected context by the time
 * `before_message_write` runs. Keeping the block in history makes future
 * turns replay stale dynamic recall and grows the prompt prefix over time.
 */
export function stripInjectedRecallFromMessage<TMessage extends { role?: string; content?: unknown }>(
  message: TMessage,
  showInjected: boolean,
): StripInjectedRecallResult<TMessage> | undefined {
  if (showInjected || message.role !== "user") return undefined;

  if (typeof message.content === "string") {
    if (!message.content.includes("<relevant-memories>")) return undefined;
    const cleaned = message.content.replace(RELEVANT_MEMORIES_RE, "").trim();
    if (cleaned === message.content) return undefined;
    return {
      message: { ...message, content: cleaned },
      strippedChars: message.content.length - cleaned.length,
      contentType: "string",
    };
  }

  if (!Array.isArray(message.content)) return undefined;

  let strippedChars = 0;
  const cleanedParts = (message.content as MessageContentPart[]).map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    if (!part.text.includes("<relevant-memories>")) return part;
    const cleaned = part.text.replace(RELEVANT_MEMORIES_RE, "").trim();
    strippedChars += part.text.length - cleaned.length;
    return { ...part, text: cleaned };
  });

  if (strippedChars === 0) return undefined;
  return {
    message: { ...message, content: cleanedParts },
    strippedChars,
    contentType: "parts",
  };
}
