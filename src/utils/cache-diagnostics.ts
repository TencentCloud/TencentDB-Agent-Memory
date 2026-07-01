/**
 * Cache shape diagnostics — optional utility for reasoning about prompt-cache
 * hit/miss across turns.
 *
 * Inspired by Reasonix `PrefixShape` (`internal/agent/cache_shape.go`, v1.13.1):
 * capture the system/tool/prefix hashes before each LLM call and compare them
 * to the previous snapshot to explain *why* a cache miss occurred.
 *
 * Usage — platform-side, after building the prompt and before calling the LLM:
 *
 *   import { captureShape, compareShape } from "./cache-diagnostics";
 *   const shape = captureShape(systemPrompt, toolSchemas);
 *   const diag = compareShape(prevShape, shape);
 *   if (diag.prefixChanged) {
 *     logger?.warn("cache miss:", diag.prefixChangeReasons.join(", "));
 *   }
 *   prevShape = shape;
 *
 * This module has zero runtime dependencies and no side effects.
 * Import it only where diagnostics are desired; tree-shaking will elide
 * it from production bundles that don't use it.
 */

const encoder = new TextEncoder();

function shortHash(data: unknown): string {
  const json = JSON.stringify(data);
  const bytes = encoder.encode(json);
  // Non-cryptographic fast hash for diagnostic comparison only.
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) - hash) + bytes[i];
    hash |= 0; // 32-bit int
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Snapshot of the prompt prefix state at one point in time. */
export interface PrefixShape {
  /** Hash of the system prompt text. */
  systemHash: string;
  /** Hash of the tool schemas / function declarations. */
  toolsHash: string;
  /** Combined hash of the full prefix (system + tools). */
  prefixHash: string;
  /** Estimated token count for tool schemas (~4 chars/token). */
  toolSchemaTokens: number;
}

/** Human-readable cache-hit diagnostic. */
export interface CacheDiagnostics {
  /** Whether any prefix component changed. */
  prefixChanged: boolean;
  /** Which components changed (e.g. ["system", "tools"]). */
  prefixChangeReasons: string[];
  /** Current prefix hash for correlation with provider-side cache metrics. */
  prefixHash: string;
  /** Estimation of the prefix token cost. */
  prefixTokens: number;
}

/**
 * Capture a snapshot of the current prefix state.
 * @param systemPrompt - The full system prompt text.
 * @param toolSchemas - Array of tool/function schemas.
 */
export function captureShape(
  systemPrompt: string,
  toolSchemas?: unknown[],
): PrefixShape {
  const toolsJSON = toolSchemas ? JSON.stringify(toolSchemas) : "[]";
  const systemHash = shortHash(systemPrompt);
  const toolsHash = shortHash(toolsJSON);
  return {
    systemHash,
    toolsHash,
    prefixHash: shortHash({ system: systemPrompt, tools: toolsJSON }),
    toolSchemaTokens: Math.ceil(toolsJSON.length / 4),
  };
}

/**
 * Compare two prefix shapes and produce diagnostics.
 * @param prev - Previous turn's shape (or null on first turn).
 * @param cur - Current turn's shape.
 */
export function compareShape(
  prev: PrefixShape | null,
  cur: PrefixShape,
): CacheDiagnostics {
  const reasons: string[] = [];
  if (prev && prev.systemHash !== cur.systemHash) reasons.push("system");
  if (prev && prev.toolsHash !== cur.toolsHash) reasons.push("tools");
  if (prev && prev.prefixHash !== cur.prefixHash && reasons.length === 0) {
    reasons.push("prefix");
  }
  return {
    prefixChanged: reasons.length > 0,
    prefixChangeReasons: reasons,
    prefixHash: cur.prefixHash,
    prefixTokens: cur.toolSchemaTokens,
  };
}
