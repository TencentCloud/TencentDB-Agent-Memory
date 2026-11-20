/**
 * Shared jieba singleton.
 *
 * `@node-rs/jieba` ships a native binary and a multi-megabyte dictionary, so the
 * instance is created once per process and shared by every caller:
 *   - FTS5 query/index segmentation (`../store/sqlite.ts`),
 *   - scene summary keyword compaction (`../scene/scene-summary.ts`).
 *
 * Loading is lazy and failure is sticky (`null`), never thrown: the native
 * binary is resolved per platform and may legitimately be missing, and both
 * callers have a degraded path (regex splitting / hard cap).
 */

import { createRequire } from "node:module";

/**
 * The subset of `@node-rs/jieba`'s surface the repo actually uses.
 *
 * `cut` — dictionary mode, keeps word order, returns every character
 *         (`tokens.join("") === input`), which is what keyword compaction needs
 *         to rebuild a summary in original order.
 * `cutForSearch` — search-engine mode, also emits sub-words; used by FTS5 so
 *         query and index tokens stay isomorphic.
 */
export interface JiebaInstance {
  cut(text: string, hmm?: boolean): string[];
  cutForSearch(text: string, hmm?: boolean): string[];
}

const require = createRequire(import.meta.url);

let _jieba: JiebaInstance | null | undefined; // undefined = not yet tried

/** Lazily build the shared instance; `null` once loading failed. */
export function getJieba(): JiebaInstance | null {
  if (_jieba !== undefined) return _jieba;
  try {
    // Deliberate `require` (not `import`): keeps ESM happy with the native
    // `.node` addon and lets the failure be swallowed in one place.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Jieba } = require("@node-rs/jieba");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dict } = require("@node-rs/jieba/dict");
    _jieba = Jieba.withDict(dict) as JiebaInstance;
  } catch {
    _jieba = null; // mark as unavailable — won't retry
  }
  return _jieba;
}

/**
 * Reset jieba state so the next `getJieba()` re-initialises.
 * Exported for testing only.
 * @internal
 */
export function _resetJiebaForTest(): void {
  _jieba = undefined;
}

/**
 * Override the jieba instance (or set to `null` to force the degraded path).
 * Exported for testing only.
 * @internal
 */
export function _setJiebaForTest(instance: JiebaInstance | null): void {
  _jieba = instance;
}
