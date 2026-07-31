import type { RecallResult } from "../core/types.js";
import type { RecallResponse } from "./types.js";

/**
 * Adapt host-neutral recall regions to the Gateway response contract.
 *
 * Legacy clients receive both regions through `context`. New clients can keep
 * stable and per-turn context separate without depending on host-specific
 * `appendSystemContext` / `prependContext` terminology.
 */
export function buildRecallResponse(result: RecallResult): RecallResponse {
  const stableContext = result.appendSystemContext;
  const dynamicContext = result.prependContext;

  return {
    context: [stableContext, dynamicContext]
      .filter((part): part is string => Boolean(part))
      .join("\n\n"),
    ...(stableContext ? { stable_context: stableContext } : {}),
    ...(dynamicContext ? { dynamic_context: dynamicContext } : {}),
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
  };
}
