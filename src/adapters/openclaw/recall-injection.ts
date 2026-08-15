import type { RecallInjectionMode } from "../../config.js";
import type { RecallResult } from "../../core/types.js";
import { compareVersionXYZ, parseVersionXYZ } from "../../utils/ensure-hook-policy.js";

/** First stable OpenClaw release whose prompt hook accepts appendContext. */
export const APPEND_CONTEXT_MIN_VERSION = [2026, 4, 27] as const;

export interface OpenClawRecallHookResult extends RecallResult {
  /** Dynamic recall placed after the current user prompt on compatible hosts. */
  appendContext?: string;
}

export interface RecallInjectionDecision {
  requested: RecallInjectionMode;
  effective: RecallInjectionMode;
  hostVersion: [number, number, number] | null;
  fallbackReason?: "unknown-host-version" | "append-context-unsupported";
}

export interface StrippedRecallMessage<TMessage extends { role?: string; content?: unknown }> {
  message: TMessage;
  removedChars: number;
  contentType: "string" | "parts";
}

const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

/**
 * Resolve the requested injection placement without sending an unsupported
 * hook field to older OpenClaw releases. Unknown versions use the safe legacy
 * path because those hosts commonly predate api.runtime.version itself.
 */
export function resolveRecallInjectionMode(
  requested: RecallInjectionMode,
  rawHostVersion: unknown,
): RecallInjectionDecision {
  const hostVersion = parseVersionXYZ(rawHostVersion);
  if (requested === "prepend") {
    return { requested, effective: "prepend", hostVersion };
  }
  if (!hostVersion) {
    return {
      requested,
      effective: "prepend",
      hostVersion,
      fallbackReason: "unknown-host-version",
    };
  }
  if (compareVersionXYZ(hostVersion, APPEND_CONTEXT_MIN_VERSION) < 0) {
    return {
      requested,
      effective: "prepend",
      hostVersion,
      fallbackReason: "append-context-unsupported",
    };
  }
  return { requested, effective: "append", hostVersion };
}

/** Convert host-neutral recall output to OpenClaw's prompt-hook contract. */
export function shapeOpenClawRecallResult(
  result: RecallResult | undefined,
  mode: RecallInjectionMode,
): OpenClawRecallHookResult | undefined {
  if (!result || mode === "prepend" || !result.prependContext) return result;

  const { prependContext, ...stableAndMetrics } = result;
  return {
    ...stableAndMetrics,
    appendContext: prependContext,
  };
}

/**
 * Remove model-visible recall markup before a user message is persisted.
 * The current model call has already consumed the hook mutation; retaining the
 * block only replays stale recall in later requests and grows history.
 */
export function stripInjectedRecallFromMessage<
  TMessage extends { role?: string; content?: unknown },
>(
  message: TMessage,
  showInjected: boolean,
): StrippedRecallMessage<TMessage> | undefined {
  if (showInjected || message.role !== "user") return undefined;

  if (typeof message.content === "string") {
    if (!message.content.includes("<relevant-memories>")) return undefined;
    const cleaned = message.content.replace(RELEVANT_MEMORIES_RE, "").trim();
    if (cleaned === message.content) return undefined;
    return {
      message: { ...message, content: cleaned },
      removedChars: message.content.length - cleaned.length,
      contentType: "string",
    };
  }

  if (!Array.isArray(message.content)) return undefined;

  let removedChars = 0;
  const cleanedParts = (message.content as Array<Record<string, unknown>>).map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    if (!part.text.includes("<relevant-memories>")) return part;
    const cleaned = part.text.replace(RELEVANT_MEMORIES_RE, "").trim();
    removedChars += part.text.length - cleaned.length;
    return { ...part, text: cleaned };
  });

  if (removedChars === 0) return undefined;
  return {
    message: { ...message, content: cleanedParts },
    removedChars,
    contentType: "parts",
  };
}
