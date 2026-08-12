/**
 * Pure helpers shared between the apply route handler and the mutation ops.
 *
 * parseMetadata: tolerate malformed JSON in metadata_json (fall back to {}).
 * atomicWrite: tmp file in the same directory + rename (atomic on POSIX).
 * hasApplied: true when ≥ 1 operation COMPLETED (it is in an applied list).
 * hasMutated: true when the store may be half-written — the question the Run
 *   state depends on, which is wider than "an operation completed".
 *
 * Pure / no `this` — testable in isolation.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtractedMemory } from "../../core/record/l1-writer.js";
import type { ApplyResult } from "./types.js";

export function parseMetadata(raw: string): ExtractedMemory["metadata"] {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as ExtractedMemory["metadata"];
  } catch {
    // malformed metadata_json — fall through to {}
  }
  return {};
}

export function hasApplied(result: ApplyResult): boolean {
  return (
    result.applied.merges.length > 0 ||
    result.applied.deletes.length > 0 ||
    result.applied.rewrites.length > 0
  );
}

/** Did this apply touch the store at all? An operation that was announced and
 * then threw counts: it is exactly the case the applied lists cannot see. */
export function hasMutated(result: ApplyResult): boolean {
  return result.storeTouched || hasApplied(result);
}

/** Atomic write: tmp file in the same directory + rename. */
export async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.apply-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, targetPath);
}
