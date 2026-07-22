import type { RecallResult } from "../../core/types.js";
import type { RecallInjectionMode } from "../../config.js";

/**
 * OpenClaw prompt-build hook result. Adds `appendContext` (content placed
 * after the user prompt) on top of the core RecallResult fields.
 */
export interface OpenClawRecallHookResult extends RecallResult {
  /** Dynamic recall appended after the user prompt (append mode, host-supported). */
  appendContext?: string;
}

/**
 * Shape core recall output for OpenClaw's prompt-build hook.
 *
 * Core always emits dynamic L1 recall as `prependContext` (host-neutral).
 * OpenClaw supports an `appendContext` field, so `append` mode moves dynamic
 * recall after the user prompt — keeping the user-prompt prefix byte-stable
 * for prefix-matching cache providers. `prepend` mode leaves it unchanged.
 *
 * Placeholder — real routing driven by the failing tests.
 */
export function shapeRecallForOpenClawHook(
  result: RecallResult | undefined,
  injectionMode: RecallInjectionMode,
): OpenClawRecallHookResult | undefined {
  if (!result) return undefined;
  if (injectionMode !== "append" || !result.prependContext) {
    return result;
  }
  const { prependContext, ...rest } = result;
  return { ...rest, appendContext: prependContext };
}
