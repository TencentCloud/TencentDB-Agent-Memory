/**
 * Map Core RecallResult to OpenClaw before_prompt_build hook fields.
 *
 * Defaults (issue #120):
 * - Stable persona/scene/tools -> prependSystemContext (before host cache boundary)
 * - Dynamic L1 -> prependContext (injectionMode=prepend) or appendContext (append)
 *
 * dualEmitStable: when true, also set appendSystemContext = stable for hosts
 * that only read appendSystemContext. Default false to avoid double injection.
 */
import type { RecallResult } from "../../core/types.js";

export type InjectionMode = "prepend" | "append";

export interface OpenClawPromptBuildResult {
  /** Stable block preferred (cache-friendly when host places it before boundary). */
  prependSystemContext?: string;
  /** Legacy stable tail only set when dualEmitStable. */
  appendSystemContext?: string;
  /** Dynamic L1 before user text. */
  prependContext?: string;
  /** Dynamic L1 after user text (host must support appendContext). */
  appendContext?: string;
}

export interface ShapeRecallOptions {
  injectionMode?: InjectionMode;
  /**
   * If true, emit the same stable string on both prependSystemContext and
   * appendSystemContext (max compatibility for hosts that only honor
   * appendSystemContext). Default false — dual inject risks double persona
   * on hosts that honor both fields.
   */
  dualEmitStable?: boolean;
}

/** Non-empty after trim, but return original bytes (no trim) for cache stability. */
function nonEmpty(text: string | undefined | null): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text.trim().length === 0) return undefined;
  return text;
}

/**
 * Shape a Core recall result for the OpenClaw before_prompt_build hook.
 */
export function shapeRecallForOpenClawHook(
  result: RecallResult | undefined | null,
  options: ShapeRecallOptions = {},
): OpenClawPromptBuildResult | undefined {
  if (!result) return undefined;

  const injectionMode: InjectionMode = options.injectionMode === "append" ? "append" : "prepend";
  const dualEmitStable = options.dualEmitStable === true;

  // Core currently stores stable in appendSystemContext; also accept
  // future/core-local prependSystemContext if present.
  // Prefer prependSystemContext when Core already set it.
  const stable =
    nonEmpty((result as { prependSystemContext?: string }).prependSystemContext) ||
    nonEmpty(result.appendSystemContext);

  const dynamic =
    nonEmpty(result.prependContext) ||
    nonEmpty((result as { appendContext?: string }).appendContext);

  const out: OpenClawPromptBuildResult = {};

  if (stable) {
    out.prependSystemContext = stable;
    if (dualEmitStable) {
      out.appendSystemContext = stable;
    }
  }

  if (dynamic) {
    if (injectionMode === "append") {
      out.appendContext = dynamic;
    } else {
      out.prependContext = dynamic;
    }
  }

  if (
    !out.prependSystemContext &&
    !out.appendSystemContext &&
    !out.prependContext &&
    !out.appendContext
  ) {
    return undefined;
  }

  return out;
}
