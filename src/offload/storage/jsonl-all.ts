/**
 * JSONL operations across ALL session files under the agent dir
 * (split from storage.ts). Used by L2 aggregation and backfill.
 * `readAllOffloadEntries` — read every offload-<session>.jsonl under dataDir,
 *   attach `_sourceFile` so rewrites can be partitioned back.
 * `rewriteAllOffloadEntries` — partition by source file, strip _sourceFile,
 *   drop empty groups (preserves existing files untouched).
 * `updateOffloadNodeIds` — read-all → patch → rewrite-all (L2 backfill).
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parseJsonlSafe, safeStringifyEntry } from "./sanitize.js";
import { readOffloadEntries, rewriteOffloadEntries } from "./jsonl-current.js";
import type { OffloadEntry, PluginLogger } from "../types.js";
import type { StorageContext } from "../storage-shim-types.js";

/** Read offload entries from ALL session files under ctx.dataDir. */
export async function readAllOffloadEntries(
  ctx: StorageContext,
  logger?: PluginLogger,
): Promise<Array<OffloadEntry & { _sourceFile?: string }>> {
  if (!existsSync(ctx.dataDir)) return [];
  let files: string[];
  try {
    files = await readdir(ctx.dataDir);
  } catch (err) {
    logger?.warn?.(
      `[context-offload] readAllOffloadEntries: failed to readdir ${ctx.dataDir}: ${(err as Error).message}`,
    );
    return [];
  }
  const offloadFiles = files
    .filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"))
    .sort();
  if (offloadFiles.length === 0) return [];
  const allEntries: Array<OffloadEntry & { _sourceFile?: string }> = [];
  let totalCorrupt = 0;
  let totalInvalid = 0;
  await Promise.all(
    offloadFiles.map(async (filename) => {
      try {
        const filePath = join(ctx.dataDir, filename);
        const content = await readFile(filePath, "utf-8");
        const { entries, corruptCount, invalidCount } = parseJsonlSafe(content, {
          sourceLabel: filename,
        });
        totalCorrupt += corruptCount;
        totalInvalid += invalidCount;
        for (const entry of entries) {
          (entry as Record<string, unknown>)._sourceFile = filename;
          allEntries.push(entry as unknown as OffloadEntry & { _sourceFile?: string });
        }
      } catch (err) {
        logger?.warn?.(
          `[context-offload] readAllOffloadEntries: failed to read ${filename}: ${(err as Error).message}`,
        );
      }
    }),
  );
  if (totalCorrupt > 0 || totalInvalid > 0) {
    logger?.warn?.(
      `[context-offload] readAllOffloadEntries: skipped ${totalCorrupt} corrupt + ${totalInvalid} invalid lines across ${offloadFiles.length} files`,
    );
  }
  return allEntries;
}

/** Write entries back to their respective source files. */
export async function rewriteAllOffloadEntries(
  ctx: StorageContext,
  entries: Array<Record<string, unknown> | any>,
): Promise<void> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of entries) {
    const sourceFile = (entry._sourceFile as string) ?? basename(ctx.offloadJsonl);
    if (!groups.has(sourceFile)) {
      groups.set(sourceFile, []);
    }
    const clean = { ...entry };
    delete clean._sourceFile;
    groups.get(sourceFile)!.push(clean);
  }
  if (existsSync(ctx.dataDir)) {
    const files = await readdir(ctx.dataDir);
    const offloadFiles = files.filter(
      (f) => f.startsWith("offload-") && f.endsWith(".jsonl"),
    );
    for (const f of offloadFiles) {
      if (!groups.has(f)) {
        groups.set(f, []);
      }
    }
  }
  await Promise.all(
    Array.from(groups.entries()).map(async ([filename, fileEntries]) => {
      const filePath = join(ctx.dataDir, filename);
      const content =
        fileEntries.map(safeStringifyEntry).join("\n") +
        (fileEntries.length > 0 ? "\n" : "");
      await writeFile(filePath, content, "utf-8");
    }),
  );
}

/** Update specific entries by tool_call_id across ALL session files (L2 backfill). */
export async function updateOffloadNodeIds(
  ctx: StorageContext,
  updates: Map<string, string>,
): Promise<void> {
  const entries = await readAllOffloadEntries(ctx);
  let changed = false;
  for (const entry of entries) {
    const newNodeId = updates.get(entry.tool_call_id);
    if (newNodeId !== undefined) {
      entry.node_id = newNodeId;
      changed = true;
    }
  }
  if (changed) {
    await rewriteAllOffloadEntries(ctx, entries as unknown as Array<Record<string, unknown>>);
  }
}
