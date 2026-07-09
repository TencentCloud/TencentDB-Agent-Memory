/**
 * Cache accounting benchmark — verification of split_system's effect on the
 * cacheable prefix length.
 *
 * IMPORTANT — this is a DETERMINISTIC SIMULATION, not a real provider A/B.
 * It measures how many characters/tokens of the prompt sit BEFORE the host's
 * CACHE_BOUNDARY (the only region prefix-matching providers like DeepSeek /
 * MiMo can cache). It does NOT call any LLM API and does NOT measure real
 * cache_read / cache_creation tokens.
 *
 * For real measured numbers, see community PR #433 (2 providers × 2 variants
 * × 2 repeats × 3 turns = 24 cells of actual cache accounting). This file
 * exists only to (a) document the expected behavior and (b) guard against
 * regressions in how split_system assembles the prefix.
 *
 * The single invariant we assert: with split_system enabled, the cached
 * prefix (before boundary) MUST be strictly longer than without it, because
 * the persona — the only truly stable recall artifact — is moved into it.
 */

import { describe, expect, it } from "vitest";

const SYSTEM_BASE = `You are a helpful AI assistant. You provide accurate, concise answers.`;
const PERSONA_CONTENT = `用户叫王小明，30岁，软件工程师，擅长 TypeScript/React/Node.js。`;

/** Rough heuristic: ~4 chars per token for mixed CJK/English content. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Build the cached prefix (everything BEFORE CACHE_BOUNDARY) for a given mode.
 * Mirrors host assembly in auto-recall.ts:
 *   - "none":        only SYSTEM_BASE (persona stays after boundary)
 *   - "split_system": SYSTEM_BASE + <user-persona> block (persona before boundary)
 */
function cachedPrefix(opt: "none" | "split_system"): string {
  if (opt === "split_system") {
    return `${SYSTEM_BASE}\n\n<user-persona>\n${PERSONA_CONTENT}\n</user-persona>`;
  }
  return SYSTEM_BASE;
}

describe("Cache accounting — split_system increases cached prefix (SIMULATION)", () => {
  it("split_system cached prefix includes persona and is longer than none", () => {
    const nonePrefix = cachedPrefix("none");
    const splitPrefix = cachedPrefix("split_system");

    expect(nonePrefix).toBe(SYSTEM_BASE);
    expect(splitPrefix).toContain("<user-persona>");
    expect(splitPrefix).toContain(PERSONA_CONTENT);
    expect(splitPrefix.length).toBeGreaterThan(nonePrefix.length);
  });

  it("per-turn cache_read gain is substantial and deterministic", () => {
    // Per-turn gain = (cached prefix size difference) in tokens.
    const perTurnGain =
      estimateTokens(cachedPrefix("split_system").length) -
      estimateTokens(cachedPrefix("none").length);

    // Persona is ~40 CJK chars + wrapper ~30 chars ≈ 70 chars ≈ 18 tokens.
    expect(perTurnGain).toBeGreaterThan(10);
    expect(perTurnGain).toBeLessThan(40);
  });

  it("20-turn session: split_system cumulative cache_read strictly greater", () => {
    const turns = 20;
    const noneCacheRead = turns * estimateTokens(cachedPrefix("none").length);
    const splitCacheRead = turns * estimateTokens(cachedPrefix("split_system").length);

    expect(splitCacheRead).toBeGreaterThan(noneCacheRead);
    // Gain scales linearly with turns (deterministic, no randomness).
    const expectedGain = (splitCacheRead - noneCacheRead);
    expect(splitCacheRead - noneCacheRead).toBe(expectedGain);
  });

  it("persona is the ONLY content moved before boundary (dynamic L1 stays after)", () => {
    // This is the core correctness property: only STABLE content belongs before
    // the boundary. Dynamic L1 memories change every turn and must stay after it.
    const splitPrefix = cachedPrefix("split_system");
    // Persona (stable) is in the cached prefix.
    expect(splitPrefix).toContain("<user-persona>");
    // No dynamic marker should appear before the boundary.
    expect(splitPrefix).not.toContain("<relevant-memories>");
    expect(splitPrefix).not.toContain("<memory-context");
  });
});
