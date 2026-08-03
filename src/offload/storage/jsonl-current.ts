/**
 * JSONL operations for the current session (split from storage.ts).
 * `appendOffloadEntries` — write-time dedup against existing IDs (with norm
 *   variant: tool_call_id with/without underscores).
 * `readOffloadEntries` — read with corruption/invalid tolerance.
 * `rewriteOffloadEntries` — overwrite (sanitized).
 * `markOffloadStatus` — patch offloaded status by tool_call_id.
 */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parseJsonlSafe, safeStringifyEntry } from "./sanitize.js";
import type { OffloadEntry, PluginLogger } from "../types.js";
import type { StorageContext } from "../storage-shim-types.js";

/** Append one or more entries to an offload JSONL with write-time dedup. */
export async function appendOffloadEntries(
  ctx: StorageContext,
  entries: OffloadEntry[],
  targetSessionId?: string,
  logger?: PluginLogger,
): Promise<void> {
  const filePath =
    targetSessionId && targetSessionId !== ctx.sessionId
      ? join(ctx.dataDir, `offload-${targetSessionId}.jsonl`)
      : ctx.offloadJsonl;

  let newEntries: OffloadEntry[] = entries;
  if (existsSync(filePath)) {
    try {
      const existingContent = await readFile(filePath, "utf-8");
      const existingIds = new Set<string>();
      for (const line of existingContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.tool_call_id === "string") {
            existingIds.add(parsed.tool_call_id);
            const norm = (parsed.tool_call_id as string).replace(/_/g, "");
            if (norm !== parsed.tool_call_id) existingIds.add(norm);
          }
        } catch {
          /* skip corrupt lines */
        }
      }

      if (existingIds.size > 0) {
        const before = newEntries.length;
        const duplicates: string[] = [];
        newEntries = entries.filter((e) => {
          const id = e.tool_call_id;
          if (!id) return true;
          const norm = id.replace(/_/g, "");
          if (existingIds.has(id) || existingIds.has(norm)) {
            duplicates.push(id);
            return false;
          }
          return true;
        });
        if (duplicates.length > 0) {
          logger?.warn?.(
            `[context-offload] appendOffloadEntries DEDUP: ${duplicates.length}/${before} entries are duplicates, writing ${newEntries.length}. file=${basename(filePath)} duplicateIds=[${duplicates.join(",")}]`,
          );
        }
      }
    } catch {
      /* If reading existing file fails, proceed without dedup */
    }
  }

  if (newEntries.length === 0) {
    logger?.info?.(
      `[context-offload] appendOffloadEntries: all ${entries.length} entries deduped, nothing to write`,
    );
    return;
  }

  const lines = newEntries.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") + "\n";
  await appendFile(filePath, lines, "utf-8");
}

/** Read all entries from the current session's offload JSONL. */
export async function readOffloadEntries(
  ctx: StorageContext,
  logger?: PluginLogger,
): Promise<OffloadEntry[]> {
  if (!existsSync(ctx.offloadJsonl)) return [];
  let content: string;
  try {
    content = await readFile(ctx.offloadJsonl, "utf-8");
  } catch (err) {
    logger?.warn?.(
      `[context-offload] readOffloadEntries: failed to read ${ctx.offloadJsonl}: ${(err as Error).message}`,
    );
    return [];
  }
  const { entries, corruptCount, invalidCount, corruptSample } = parseJsonlSafe(
    content,
    { sourceLabel: basename(ctx.offloadJsonl) },
  );
  if (corruptCount > 0 || invalidCount > 0) {
    logger?.warn?.(
      `[context-offload] readOffloadEntries: skipped ${corruptCount} corrupt + ${invalidCount} invalid lines in ${basename(ctx.offloadJsonl)}. Sample: ${corruptSample?.slice(0, 100)}`,
    );
  }
  return entries as unknown as OffloadEntry[];
}

/** Rewrite the current session's offload JSONL with the given entries (sanitized) */
export async function rewriteOffloadEntries(
  ctx: StorageContext,
  entries: OffloadEntry[],
): Promise<void> {
  const content =
    entries.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  await writeFile(ctx.offloadJsonl, content, "utf-8");
}

/** Mark offload entries by tool_call_id with an `offloaded` status. */
export async function markOffloadStatus(
  ctx: StorageContext,
  updates: Map<string, string | boolean>,
): Promise<void> {
  if (!existsSync(ctx.offloadJsonl) || updates.size === 0) return;
  const entries = (await readOffloadEntries(ctx)) as Array<OffloadEntry & { offloaded?: string | boolean }>;
  let changed = false;
  for (const entry of entries) {
    const status = updates.get(entry.tool_call_id);
    if (status !== undefined && entry.offloaded !== status) {
      entry.offloaded = status;
      changed = true;
    }
  }
  if (changed) {
    await rewriteOffloadEntries(ctx, entries);
  }
}
