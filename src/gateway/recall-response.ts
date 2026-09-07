import type { RecallResult } from "../core/types.js";
import type { RecallResponse } from "./types.js";

/**
 * Flatten host-neutral recall regions into the Gateway's single context field.
 *
 * OpenClaw can place stable and dynamic regions independently, while Gateway
 * clients consume one string. Keep the existing stable region first and append
 * dynamic L1 recall so the cache-aware split does not drop recalled memories.
 */
export function buildRecallResponse(result: RecallResult): RecallResponse {
  const context = [result.appendSystemContext, result.prependContext]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  return {
    context,
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
  };
}
