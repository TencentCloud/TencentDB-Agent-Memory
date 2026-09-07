import type { RecallInjectionMode } from "../../config.js";
import type { RecallResult } from "../../core/types.js";

export interface OpenClawRecallHookResult
  extends Omit<RecallResult, "stableContext" | "dynamicContext"> {
  appendSystemContext?: string;
  prependContext?: string;
  appendContext?: string;
}

/**
 * Shape host-neutral recall output for OpenClaw's prompt-build hook.
 *
 * Core exposes placement-neutral dynamic L1 recall. This OpenClaw boundary
 * maps it before or after the current user prompt according to configuration.
 */
export function shapeOpenClawRecallResult(
  result: RecallResult | undefined,
  mode: RecallInjectionMode,
): OpenClawRecallHookResult | undefined {
  if (!result) return undefined;

  const { stableContext, dynamicContext, ...metadata } = result;
  const rest = stableContext
    ? { ...metadata, appendSystemContext: stableContext }
    : metadata;

  if (!dynamicContext) {
    return rest;
  }

  if (mode === "append") {
    return {
      ...rest,
      appendContext: dynamicContext,
    };
  }

  return {
    ...rest,
    prependContext: dynamicContext,
  };
}
