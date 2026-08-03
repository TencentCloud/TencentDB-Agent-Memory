/**
 * MD (Tool Result Refs) operations (split from storage.ts).
 * `writeRefMd` — write tool result content to `<dataDir>/refs/<iso>.md` with
 *   timestamp + tool name header; return relative path.
 * `readRefMd` — read by relative path (returns null if missing).
 * `isoToFilename` — ISO 8601 → safe filename (colons/dots → dashes, + → p).
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UNSAFE_CHAR_RE } from "./sanitize-types.js";
import { sanitizeText } from "./sanitize.js";
import type { StorageContext } from "../storage-shim-types.js";

/** Convert ISO 8601 timestamp to a safe filename (replace special chars) */
export function isoToFilename(iso: string): string {
  return iso.replace(/:/g, "-").replace(/\./g, "-").replace(/\+/g, "p");
}

/** Write tool result content to a ref MD file, return relative path */
export async function writeRefMd(
  ctx: StorageContext,
  timestamp: string,
  toolName: string,
  content: string,
): Promise<string> {
  const filename = `${isoToFilename(timestamp)}.md`;
  const filePath = join(ctx.refsDir, filename);
  const safeContent = (content ?? "").replace(UNSAFE_CHAR_RE, "");
  const header = `# Tool Result: ${toolName}\n\n**Timestamp:** ${timestamp}\n\n---\n\n`;
  await writeFile(filePath, header + safeContent, "utf-8");
  return `refs/${filename}`;
}

/** Read a ref MD file by relative path */
export async function readRefMd(
  ctx: StorageContext,
  refPath: string,
): Promise<string | null> {
  const filePath = join(ctx.dataDir, refPath);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

// Re-export sanitizeText to keep a stable public surface (used by callers
// that previously imported both sanitizeText and writeRefMd from storage.ts).
export { sanitizeText };
