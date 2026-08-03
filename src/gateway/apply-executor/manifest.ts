/**
 * Trust-boundary manifest recheck for /memory/apply (ТЗ §5.5).
 *
 * Every baseline file must be byte-identical (sha256) to the spawn-time
 * snapshot, EXCEPT files whose current content equals a rewrite target in
 * this same diff — those were changed by a previous apply run (heal
 * re-run), which is our own write, not a drift.
 *
 * Pure function (no `this`) — dataDir + resolveWithinDataDir are injected.
 * Split from validate.ts so the file stays ≤150 lines (manifest recheck is
 * file-system I/O, validation is in-memory + DB).
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { ManifestDriftError } from "./errors.js";
import { resolveWithinDataDir } from "./apply-helpers.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { ParsedApplyRequest } from "./types.js";

export function checkManifest(
  deps: ApplyExecutorDeps,
  parsed: ParsedApplyRequest,
): void {
  const { manifest, diff } = parsed;
  const rewrites = new Map<string, string>();
  for (const op of diff.rewriteBlock ?? []) rewrites.set(op.path, op.content);
  if (diff.rewritePersona !== undefined)
    rewrites.set("persona.md", diff.rewritePersona);

  for (const [relPath, baselineHash] of Object.entries(manifest.baseline)) {
    const resolved = resolveWithinDataDir(deps.dataDir, relPath);
    if (!resolved) {
      throw new ManifestDriftError(
        `manifest path "${relPath}" escapes the data dir`,
      );
    }
    let current: string;
    try {
      current = fs.readFileSync(resolved, "utf-8");
    } catch {
      throw new ManifestDriftError(
        `manifest drift: "${relPath}" missing on disk (baseline hash ${baselineHash.slice(0, 8)}…)`,
      );
    }
    const currentHash = createHash("sha256").update(current).digest("hex");
    if (currentHash === baselineHash) continue;
    // Tolerance: content already equals the diff's rewrite for this path
    // (our own previous application — heal path).
    const expected = rewrites.get(relPath);
    if (expected !== undefined && current === expected) continue;
    throw new ManifestDriftError(
      `manifest drift: "${relPath}" changed since spawn (baseline ${baselineHash.slice(0, 8)}…, current ${currentHash.slice(0, 8)}…)`,
    );
  }
}
