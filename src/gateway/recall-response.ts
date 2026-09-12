import type { RecallResult } from "../core/types.js";
import type { RecallResponse } from "./types.js";

/**
 * Serialize recall without collapsing the core's dynamic/stable prompt
 * boundary. `context` keeps its historical stable-context meaning.
 */
export function toGatewayRecallResponse(result: RecallResult): RecallResponse {
  const stable = result.appendSystemContext ?? "";
  return {
    context: stable,
    ...(result.prependContext
      ? { prepend_context: result.prependContext }
      : {}),
    ...(result.appendSystemContext
      ? { append_system_context: result.appendSystemContext }
      : {}),
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
  };
}
