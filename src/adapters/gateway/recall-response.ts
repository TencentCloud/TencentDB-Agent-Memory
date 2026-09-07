import type { RecallInjectionMode } from "../../config.js";
import type { RecallResult } from "../../core/types.js";
import type { RecallResponse } from "../../gateway/types.js";

/**
 * Serialize host-neutral recall output for Gateway clients.
 *
 * Structured fields let each agent framework choose its native placement.
 * `context` remains a combined fallback so older Hermes clients continue to
 * receive both stable and dynamic recall after a Gateway upgrade.
 */
export function shapeGatewayRecallResponse(
  result: RecallResult,
  injectionMode: RecallInjectionMode,
): RecallResponse {
  const stableContext = result.stableContext ?? "";
  const dynamicContext = result.dynamicContext ?? "";
  const context = [stableContext, dynamicContext]
    .filter((part) => part.length > 0)
    .join("\n\n");

  return {
    context,
    stable_context: stableContext,
    dynamic_context: dynamicContext,
    injection_mode: injectionMode,
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
  };
}
