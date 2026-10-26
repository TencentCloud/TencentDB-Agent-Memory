/**
 * Escape a literal string for use inside a Redis glob-style pattern
 * (the MATCH clause of SCAN / SSCAN / HSCAN / ZSCAN and KEYS).
 *
 * Redis patterns treat `*`, `?`, `[...]` and `\` as wildcards / escape
 * sequences. User-controlled values (e.g. instanceId) interpolated into a
 * pattern without escaping would match far more than intended — an id of
 * "*" matches every key.
 */
export function escapeRedisGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, "\\$&");
}
