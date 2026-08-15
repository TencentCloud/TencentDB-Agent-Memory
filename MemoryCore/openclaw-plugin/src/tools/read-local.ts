/**
 * tdai_read_local tool — reads local scene-memory files (persona.md,
 * scene_blocks/*.md, ...) by relative path from a configured local directory.
 *
 * COS-less alternative to tdai_read_cos for local deployments where the memory
 * server writes its artifacts to a local directory the plugin can read
 * directly (see issue #762).
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

interface Logger {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Validate a user-supplied relative path before reading under the local root.
 * Rejects anything that could escape the root: empty, absolute paths (POSIX
 * and Windows drive-letter/UNC), and any ".." traversal.
 */
export function isSafeRelativePath(path: string | undefined | null): boolean {
  if (!path?.trim()) return false;
  if (path.includes("..")) return false;
  if (isAbsolute(path)) return false;
  // Windows drive-letter (C:\…) and UNC (\\server\…) — reject even on POSIX.
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  if (path.startsWith("\\\\")) return false;
  return true;
}

export async function handleReadLocal(
  localDir: string,
  params: { path: string },
  logger?: Logger,
) {
  const { path } = params;

  if (!isSafeRelativePath(path)) {
    return { content: [{ type: "text" as const, text: `Invalid path: "${path ?? ""}"` }] };
  }

  // Defense-in-depth: confirm the resolved path is still inside localDir.
  const full = resolve(localDir, path);
  const rel = relative(localDir, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { content: [{ type: "text" as const, text: `Invalid path: "${path}"` }] };
  }

  try {
    logger?.debug?.(`[read-local] read: "${path}"`);
    const content = await readFile(full, "utf-8");
    logger?.debug?.(`[read-local] ✅ "${path}" (${content.length} chars)`);
    return { content: [{ type: "text" as const, text: content }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`[read-local] Failed to read "${path}": ${msg}`);
    return { content: [{ type: "text" as const, text: `Failed to read file: ${msg}` }] };
  }
}
