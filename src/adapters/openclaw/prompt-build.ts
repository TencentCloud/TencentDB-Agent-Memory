import type { RecallResult } from "../../core/types.js";

export interface OpenClawPromptBuildResult {
  prependContext?: string;
  prependSystemContext?: string;
}

/**
 * Place stable recall additions before OpenClaw's cache boundary while keeping
 * turn-specific recall in the current user context.
 */
export function mapRecallResultToOpenClawPromptBuild(
  result: RecallResult | undefined,
): OpenClawPromptBuildResult | undefined {
  if (!result) return undefined;

  const mapped: OpenClawPromptBuildResult = {};
  if (result.prependContext) mapped.prependContext = result.prependContext;
  if (result.appendSystemContext) mapped.prependSystemContext = result.appendSystemContext;

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}
