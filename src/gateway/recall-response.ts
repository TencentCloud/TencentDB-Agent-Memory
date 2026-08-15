import type { RecallResult } from "../core/types.js";
import type {
  RecallContextPartResponse,
  RecallContextPartsResponse,
  RecallResponse,
} from "./types.js";

function toResponsePart(
  part: NonNullable<NonNullable<RecallResult["contextParts"]>["stable"]>,
): RecallContextPartResponse {
  return {
    content: part.content,
    placement: part.placement,
    cache_policy: part.cachePolicy,
    persist: part.persist,
  };
}

function toResponseParts(parts: RecallResult["contextParts"]): RecallContextPartsResponse | undefined {
  if (!parts?.stable && !parts?.dynamic) return undefined;

  return {
    stable: parts.stable ? toResponsePart(parts.stable) : undefined,
    dynamic: parts.dynamic ? toResponsePart(parts.dynamic) : undefined,
  };
}

export function buildRecallResponse(result: RecallResult): RecallResponse {
  return {
    context: result.appendSystemContext ?? "",
    stable_context: result.appendSystemContext,
    dynamic_context: result.prependContext,
    context_parts: toResponseParts(result.contextParts),
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
    cache_debug: result.cacheDebug,
  };
}
