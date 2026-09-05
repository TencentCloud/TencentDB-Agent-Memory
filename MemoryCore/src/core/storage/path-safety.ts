/**
 * Shared storage-key traversal guard.
 *
 * Extracted from LocalStorageBackend's `resolvePath` (CR-6 fix, 2026-05-19)
 * so every IStorageBackend implementation that maps a key onto a real
 * filesystem path (local, git, ...) validates it identically instead of
 * carrying its own copy that could drift.
 */
import { sep, resolve, relative } from "node:path";

/**
 * Validate a storage key and resolve it to a safe path relative to `rootDir`.
 *
 * Rejected:
 * - Empty key
 * - Keys containing NUL (\0)
 * - Keys with a leading "/" or "\" (absolute paths)
 * - Keys whose resolved path falls outside rootDir (../ traversal, including
 *   the "sibling directory with the same name prefix" bypass)
 *
 * @returns The key's path relative to rootDir, using OS-native separators
 *   (e.g. "" for the root itself, "scene_blocks/a.md" → "scene_blocks<sep>a.md").
 *   Callers that need an absolute path can `resolve(rootDir, result)`.
 */
export function resolveSafeRelativePath(rootDir: string, key: string): string {
  if (!key || typeof key !== "string") {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
  if (key.includes("\0")) {
    throw new Error("Storage key must not contain NUL character");
  }
  if (key.startsWith("/") || key.startsWith("\\")) {
    throw new Error(`Storage key must be relative, got absolute: ${key}`);
  }

  // Normalize key separators to OS path separators
  const normalized = key.split("/").join(sep);

  // Compute the absolute resolved path; resolve() collapses ".." segments.
  const absRoot = resolve(rootDir);
  const absResolved = resolve(absRoot, normalized);

  // Ensure the resolved path stays inside rootDir. Append sep so that
  // a key like "../rootDir2/foo" (which resolves to a sibling directory
  // whose name happens to start with rootDir's name) is also rejected.
  const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
  if (absResolved !== absRoot && !absResolved.startsWith(rootWithSep)) {
    throw new Error(`Path traversal rejected: key "${key}" escapes rootDir`);
  }

  return relative(absRoot, absResolved);
}
