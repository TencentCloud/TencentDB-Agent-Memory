/**
 * Observation-only diagnostics for prompt-cache prefix stability.
 * Logs stable-block length + short hash and dynamic placement.
 * Optional session continuity: same|changed|first (does NOT freeze content).
 */
import { createHash } from "node:crypto";

export type DynamicPlacement = "prepend" | "append" | "none";
export type StableContinuity = "first" | "same" | "changed";

export interface RecallShapeInput {
  prependSystemContext?: string;
  appendSystemContext?: string;
  prependContext?: string;
  appendContext?: string;
}

export interface RecallShapeDescription {
  stableChars: number;
  stableHash: string;
  dynamicPlacement: DynamicPlacement;
  dynamicChars: number;
  line: string;
}

/** Per-session last stable hash for continuity logs (TTL + hard cap). */
const lastStableBySession = new Map<string, { hash: string; ts: number }>();
const CONTINUITY_TTL_MS = 30 * 60 * 1000;
const CONTINUITY_MAX = 5_000;

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function sweepContinuity(now: number): void {
  for (const [k, v] of lastStableBySession) {
    if (now - v.ts > CONTINUITY_TTL_MS) lastStableBySession.delete(k);
  }
  if (lastStableBySession.size <= CONTINUITY_MAX) return;
  const entries = [...lastStableBySession.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const drop = entries.length - CONTINUITY_MAX;
  for (let i = 0; i < drop; i++) lastStableBySession.delete(entries[i][0]);
}

/**
 * Prefer prependSystemContext as the stable block when present
 * (cache-friendly placement); fall back to appendSystemContext.
 */
export function describeRecallShape(shape: RecallShapeInput): RecallShapeDescription {
  const stable =
    shape.prependSystemContext?.trim() ||
    shape.appendSystemContext?.trim() ||
    "";
  const stableChars = stable.length;
  const stableHash = stableChars > 0 ? shortHash(stable) : "empty";

  let dynamicPlacement: DynamicPlacement = "none";
  let dynamicChars = 0;
  if (shape.prependContext && shape.prependContext.length > 0) {
    dynamicPlacement = "prepend";
    dynamicChars = shape.prependContext.length;
  } else if (shape.appendContext && shape.appendContext.length > 0) {
    dynamicPlacement = "append";
    dynamicChars = shape.appendContext.length;
  }

  const line =
    `stable=${stableChars}chars(hash=${stableHash}), ` +
    `dynamic=${dynamicPlacement}/${dynamicChars}chars`;

  return { stableChars, stableHash, dynamicPlacement, dynamicChars, line };
}

/**
 * Record stable hash for a session and return continuity vs previous turn.
 * Empty stable ("empty") still updates state so "first" is only once.
 */
export function noteStableContinuity(
  sessionKey: string | undefined | null,
  stableHash: string,
): StableContinuity {
  if (!sessionKey) return "first";
  const now = Date.now();
  sweepContinuity(now);
  const prev = lastStableBySession.get(sessionKey);
  lastStableBySession.set(sessionKey, { hash: stableHash, ts: now });
  if (!prev) return "first";
  return prev.hash === stableHash ? "same" : "changed";
}

/** Last observed stable hash for a session (for llm_output metrics join). */
export function getLastStableHash(sessionKey: string | undefined | null): string | null {
  if (!sessionKey) return null;
  return lastStableBySession.get(sessionKey)?.hash ?? null;
}

/** Test-only: clear continuity map. */
export function resetStableContinuityForTests(): void {
  lastStableBySession.clear();
}

/**
 * Longest common prefix length of two strings (code units).
 * Used in tests to prove multi-turn system prefix stability when only dynamic changes.
 */
export function longestCommonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
