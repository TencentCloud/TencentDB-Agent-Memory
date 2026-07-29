/**
 * Stable system-prompt context composition for prompt-cache friendliness (issue #120).
 *
 * The system-prompt region is the most cache-sensitive part of a request for
 * prefix-matching providers (DeepSeek, MiMo, ...). To keep it cacheable, the
 * stable recall block (persona, scene navigation, tools guide) must be:
 *   1. Byte-identical across turns while the underlying persona/scene are unchanged.
 *   2. Independent of per-turn dynamic L1 recall (which memories matched this turn).
 *
 * Previously the tools guide was appended whenever *either* stable content *or*
 * this turn's dynamic memories were present, so the system region flipped between
 * "guide" and "" across turns for users without a persona — busting the
 * system-prompt cache. This module decouples the stable region from dynamic recall.
 */

export interface StableContextParts {
  /** L3 persona content (stable, slowly-changing). */
  personaContent?: string;
  /** L2 scene navigation (stable, slowly-changing). */
  sceneNavigation?: string;
}

export interface ComposeStableContextOptions {
  /** Tools guide block appended so the agent knows how to search deeper. */
  toolsGuide?: string;
}

/**
 * Compose the stable system-prompt context deterministically.
 *
 * Returns undefined when there is no stable content to inject. The tools guide is
 * only attached when there is stable persona/scene content, so the presence of the
 * system region never depends on this turn's dynamic recall outcome.
 */
export function composeStableSystemContext(
  parts: StableContextParts,
  opts: ComposeStableContextOptions = {},
): string | undefined {
  const stableParts: string[] = [];
  if (parts.personaContent) {
    stableParts.push(`<user-persona>\n${parts.personaContent}\n</user-persona>`);
  }
  if (parts.sceneNavigation) {
    stableParts.push(`<scene-navigation>\n${parts.sceneNavigation}\n</scene-navigation>`);
  }
  if (stableParts.length === 0) {
    return undefined;
  }
  if (opts.toolsGuide) {
    stableParts.push(opts.toolsGuide);
  }
  return stableParts.join("\n\n");
}

/** Result of tracking stable-context stability across a sequence of turns. */
export interface StableContextStability {
  /** Turns (after the first) whose stable region differed from the previous turn. */
  changeCount: number;
  /** Per-turn flags: true when the stable region changed vs the previous turn. */
  changedPerTurn: boolean[];
}

/**
 * Count how often the stable system region changes across turns. A cache-friendly
 * system region changes only when persona/scene actually change, not every turn.
 */
export function analyzeStableContextStability(
  blocks: Array<string | undefined>,
): StableContextStability {
  let previous: string | undefined;
  let changeCount = 0;
  const changedPerTurn: boolean[] = [];

  blocks.forEach((block, index) => {
    const normalized = block ?? "";
    const changed = index > 0 && normalized !== (previous ?? "");
    if (changed) changeCount += 1;
    changedPerTurn.push(changed);
    previous = block;
  });

  return { changeCount, changedPerTurn };
}
