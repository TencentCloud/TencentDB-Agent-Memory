/**
 * Shared text utility functions for the memory-tdai plugin.
 */

/**
 * Extract meaningful words from text (supports CJK and Latin).
 *
 * Used by both auto-recall (keyword search) and l1-dedup (keyword candidate recall).
 * Extracted to a shared module to prevent implementation drift.
 */
export function extractWords(text: string): Set<string> {
  const words = new Set<string>();

  // Latin words (2+ chars)
  const latinWords = text.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (latinWords) {
    for (const w of latinWords) words.add(w);
  }

  // CJK characters (each char as a "word", plus 2-grams within a contiguous run).
  // Grouping by run keeps bigrams from being built across punctuation or latin
  // text: matching a flat character array would produce tokens such as "好世"
  // for "你好，世界", which never occur as adjacent characters in the source.
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (const c of run) words.add(c);
      for (let i = 0; i < run.length - 1; i++) {
        words.add(run.slice(i, i + 2));
      }
    }
  }

  return words;
}
