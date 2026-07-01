import type { RecallResult } from "../../core/types.js";

export interface OpenClawPromptBuildResult {
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

/**
 * Map host-neutral recall output into OpenClaw's prompt-build hook shape.
 *
 * The core returns stable memory guidance as appendSystemContext for gateway
 * compatibility. In OpenClaw, appendSystemContext is appended after the base
 * system prompt, which places it after OPENCLAW_CACHE_BOUNDARY. Returning it as
 * prependSystemContext keeps stable persona / scene / tool guidance before the
 * boundary while leaving dynamic L1 recall in the current user prompt.
 */
export function mapRecallResultToOpenClawPromptBuild(
  result: RecallResult,
): OpenClawPromptBuildResult | undefined {
  const hookResult: OpenClawPromptBuildResult = {};

  if (result.prependContext) {
    hookResult.prependContext = result.prependContext;
  }

  if (result.appendSystemContext) {
    hookResult.prependSystemContext = result.appendSystemContext;
  }

  return Object.keys(hookResult).length > 0 ? hookResult : undefined;
}
