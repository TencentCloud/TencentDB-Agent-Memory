import type { RecallResult } from "../../core/types.js";

export interface OpenClawPromptBuildResult {
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}

/**
 * Map host-neutral recall output to OpenClaw's prompt mutation fields.
 *
 * OpenClaw composes prependSystemContext before its system-prompt cache
 * boundary. The plugin's stable memory context is therefore returned through
 * that host-specific field, while dynamic L1 recall remains in the user prompt
 * via prependContext or appendContext.
 */
export function mapRecallResultToOpenClawPromptBuild(
  result: RecallResult | undefined,
): OpenClawPromptBuildResult | undefined {
  if (!result) return undefined;

  const mapped: OpenClawPromptBuildResult = {};
  if (result.prependContext) mapped.prependContext = result.prependContext;
  if (result.appendContext) mapped.appendContext = result.appendContext;
  if (result.appendSystemContext) mapped.prependSystemContext = result.appendSystemContext;

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}
