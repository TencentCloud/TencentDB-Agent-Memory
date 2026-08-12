import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
/**
 * Detect an ESM CLI entry even when a package manager invokes it through a
 * symlink. Node resolves import.meta.url to the real file, while argv can keep
 * the symlink path.
 */
export function isMainModule(
  importMetaUrl: string,
  entry = process.argv[1],
): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return importMetaUrl === pathToFileURL(entry).href;
  }
}
