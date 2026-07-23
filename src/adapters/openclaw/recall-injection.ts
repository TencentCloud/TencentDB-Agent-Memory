import type { RecallInjectionMode } from "../../config.js";
import type { RecallResult } from "../../core/types.js";
import {
  compareVersionXYZ,
  parseVersionXYZ,
} from "../../utils/ensure-hook-policy.js";

export const PREPEND_SYSTEM_CONTEXT_MIN_VERSION = [2026, 4, 26] as const;
export const APPEND_CONTEXT_MIN_VERSION = [2026, 4, 27] as const;

export type RecallInjectionFallbackReason =
  | "unknown-host-version"
  | "append-context-unsupported";

export interface OpenClawRecallCompatibility {
  requestedMode: RecallInjectionMode;
  effectiveMode: RecallInjectionMode;
  hostVersion: [number, number, number] | null;
  supportsPrependSystemContext: boolean;
  fallbackReason?: RecallInjectionFallbackReason;
}

export interface OpenClawRecallHookResult
  extends Omit<RecallResult, "prependContext" | "appendSystemContext"> {
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

export function resolveOpenClawRecallCompatibility(
  requestedMode: RecallInjectionMode,
  rawHostVersion: unknown,
): OpenClawRecallCompatibility {
  const hostVersion = parseVersionXYZ(rawHostVersion);
  const supportsPrependSystemContext =
    hostVersion !== null &&
    compareVersionXYZ(hostVersion, PREPEND_SYSTEM_CONTEXT_MIN_VERSION) >= 0;

  if (requestedMode === "prepend") {
    return {
      requestedMode,
      effectiveMode: "prepend",
      hostVersion,
      supportsPrependSystemContext,
    };
  }

  if (!hostVersion) {
    return {
      requestedMode,
      effectiveMode: "prepend",
      hostVersion,
      supportsPrependSystemContext,
      fallbackReason: "unknown-host-version",
    };
  }

  if (compareVersionXYZ(hostVersion, APPEND_CONTEXT_MIN_VERSION) < 0) {
    return {
      requestedMode,
      effectiveMode: "prepend",
      hostVersion,
      supportsPrependSystemContext,
      fallbackReason: "append-context-unsupported",
    };
  }

  return {
    requestedMode,
    effectiveMode: "append",
    hostVersion,
    supportsPrependSystemContext,
  };
}

export function shapeOpenClawRecallResult(
  result: RecallResult | undefined,
  compatibility: OpenClawRecallCompatibility,
): OpenClawRecallHookResult | undefined {
  if (!result) return undefined;

  const { prependContext, appendSystemContext, ...metrics } = result;
  const hookResult: OpenClawRecallHookResult = { ...metrics };

  if (prependContext) {
    if (compatibility.effectiveMode === "append") {
      hookResult.appendContext = prependContext;
    } else {
      hookResult.prependContext = prependContext;
    }
  }

  if (appendSystemContext) {
    if (compatibility.supportsPrependSystemContext) {
      hookResult.prependSystemContext = appendSystemContext;
    } else {
      hookResult.appendSystemContext = appendSystemContext;
    }
  }

  const hasPromptContext =
    hookResult.prependContext ||
    hookResult.appendContext ||
    hookResult.prependSystemContext ||
    hookResult.appendSystemContext;
  return hasPromptContext ? hookResult : undefined;
}

