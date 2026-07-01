import type { RecallResult } from "../core/types.js";
import type { RecallResponse } from "./types.js";

/** Preserve the core's stable/dynamic context boundary across HTTP. */
export function buildGatewayRecallResponse(result: RecallResult): RecallResponse {
  return {
    // Do not change the legacy field's semantics for Hermes/existing clients.
    context: result.appendSystemContext ?? "",
    ...(result.prependContext ? { prepend_context: result.prependContext } : {}),
    ...(result.appendSystemContext
      ? { append_system_context: result.appendSystemContext }
      : {}),
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
  };
}
