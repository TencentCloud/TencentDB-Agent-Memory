/**
 * JEV state overflow handling: configurable limit + optional overflow policies.
 *
 * The L3 JEV gate feeds `{ current_persona, changed_scenes }` to the decision
 * provider. When the serialized payload exceeds the state limit, the stock
 * upstream behavior is to defer L3 and leave the persona checkpoint untouched.
 * In an active library the changed-scene set only grows between rebuilds, so
 * once a library crosses the limit the gate can park indefinitely while every
 * caller perceives a healthy no-op.
 *
 * This module keeps that defer path as the default (upstream-compatible) and
 * adds two opt-in policies:
 *
 *   "trim"     - shrink the payload to fit by truncating the content of the
 *                 largest scenes (head + tail kept, filenames/summaries always
 *                 retained). Cheap, no model call, but lossy in a *positional*
 *                 way: the cut lands wherever the byte budget happens to run
 *                 out, which can remove exactly the paragraphs the decision
 *                 needs.
 *   "semantic" - ask an LLM to rewrite the oversized scenes into shorter but
 *                 semantically equivalent versions (drop stale/superseded
 *                 facts, collapse repeated narration, keep every still-valid
 *                 fact), then re-serialize. Lossy in a *content* way but the
 *                 surviving text is still a faithful summary of the scene, so
 *                 the decision sees real information instead of a chopped
 *                 middle. Falls back to "trim" when the model call fails or
 *                 the result still does not fit.
 *
 * Env knobs (all optional; defaults preserve upstream behavior):
 *   JEV_STATE_LIMIT_CHARS       positive integer, default 32000
 *   JEV_STATE_OVERFLOW_POLICY   "defer" (default) | "trim" | "semantic"
 */

export const JEV_STATE_LIMIT_CHARS_DEFAULT = 32_000;

export type JevOverflowPolicy = "defer" | "trim" | "semantic";

export function resolveJevStateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JEV_STATE_LIMIT_CHARS?.trim();
  if (raw && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed > 0) return parsed;
  }
  return JEV_STATE_LIMIT_CHARS_DEFAULT;
}

export function resolveJevOverflowPolicy(env: NodeJS.ProcessEnv = process.env): JevOverflowPolicy {
  const raw = env.JEV_STATE_OVERFLOW_POLICY?.trim().toLowerCase();
  if (raw === "trim") return "trim";
  if (raw === "semantic") return "semantic";
  return "defer";
}

/** Subset of the JEV state payload this module reads or rewrites. */
export interface JevStatePayload {
  current_persona: string;
  changed_scenes: Array<{
    filename: string;
    summary: string;
    updated: string;
    content: string;
  }>;
}

export interface JevTrimResult {
  /** Re-serialized state payload that fits the limit. */
  state: string;
  /** Serialized length before trimming. */
  originalChars: number;
  /** Chars saved by this trim pass. */
  trimmedChars: number;
  /** Scenes whose content was (partially) truncated. */
  trimmedScenes: string[];
}

function serialize(payload: JevStatePayload): string {
  return JSON.stringify(payload);
}

/**
 * Shrink an oversized JEV state payload until it fits `limit`.
 *
 * Strategy: keep every scene entry (filename/summary/updated always survive)
 * and truncate the content of the currently largest scene - head + tail with
 * an inline marker in the middle - until the serialized payload fits.
 *
 * Returns `null` when even a payload with every scene content emptied still
 * exceeds the limit; callers should then fall back to the defer path.
 */
export function trimJevStateForLimit(payload: JevStatePayload, limit: number): JevTrimResult | null {
  const original = serialize(payload);
  if (original.length <= limit) {
    return { state: original, originalChars: original.length, trimmedChars: 0, trimmedScenes: [] };
  }

  const scenes = payload.changed_scenes.map((scene) => ({ ...scene }));
  const working: JevStatePayload = { ...payload, changed_scenes: scenes };
  let state = serialize(working);
  const trimmed = new Set<string>();
  let guard = 0;

  while (state.length > limit && guard < 1_000) {
    guard += 1;
    let index = -1;
    let maxLen = -1;
    for (let i = 0; i < scenes.length; i += 1) {
      const len = scenes[i].content.length;
      if (len > maxLen) {
        maxLen = len;
        index = i;
      }
    }
    // Nothing left to shrink (no scenes, or every content already empty).
    if (index < 0 || maxLen === 0) break;

    const scene = scenes[index];
    const overflow = state.length - limit;
    // Reserve room for the inline marker and any JSON escaping it may add.
    const keep = Math.max(0, maxLen - overflow - 64);
    if (keep <= 0) {
      scene.content = "";
    } else {
      const head = Math.ceil(keep / 2);
      const tail = keep - head;
      const dropped = maxLen - keep;
      scene.content =
        scene.content.slice(0, head) +
        `\n\n[... truncated ${dropped} chars ...]\n\n` +
        scene.content.slice(maxLen - tail);
    }
    trimmed.add(scene.filename);
    state = serialize(working);
  }

  if (state.length > limit) return null;
  return {
    state,
    originalChars: original.length,
    trimmedChars: original.length - state.length,
    trimmedScenes: [...trimmed],
  };
}
