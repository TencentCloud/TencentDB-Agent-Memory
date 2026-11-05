import type { RecallResult } from "../../core/types.js";

export interface OpenClawPromptBuildResult {
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

/**
 * Convert host-neutral recall output to OpenClaw's prompt-build hook shape.
 *
 * Core uses appendSystemContext for stable persona / scene / tool guidance.
 * OpenClaw composes prependSystemContext before its cache boundary, so the
 * plugin returns stable recall through that host field while dynamic L1 recall
 * stays in prependContext.
 */
export function mapRecallResultToOpenClawPromptBuild(
  result: RecallResult | undefined,
): OpenClawPromptBuildResult | undefined {
  if (!result) return undefined;

  const hookResult: OpenClawPromptBuildResult = {};

  if (result.prependContext) {
    hookResult.prependContext = result.prependContext;
  }

  if (result.appendSystemContext) {
    hookResult.prependSystemContext = result.appendSystemContext;
  }

  return Object.keys(hookResult).length > 0 ? hookResult : undefined;
}
