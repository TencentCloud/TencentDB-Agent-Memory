/**
 * Entry-module detection for CLI mains (`node --import tsx src/.../main.ts`).
 *
 * `process.argv[1]` uses the platform's path separators — on Windows that
 * means backslashes, so a suffix containing "/" (e.g. "claude-code/main.ts")
 * would never match and the server would exit silently instead of starting.
 * Backslashes are therefore normalized to "/" before the suffix check.
 */

/**
 * True when `argv1` (usually `process.argv[1]`) ends with one of `suffixes`
 * after normalizing Windows backslashes to forward slashes.
 */
export function isMainModule(argv1: string | undefined, suffixes: readonly string[]): boolean {
  if (!argv1) return false;
  const normalized = argv1.replace(/\\/g, "/");
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}
