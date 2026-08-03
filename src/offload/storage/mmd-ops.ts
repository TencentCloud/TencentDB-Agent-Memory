/**
 * MMD (Mermaid) operations (split from storage.ts).
 * `writeMmd` / `readMmd` / `deleteMmd` / `listMmds` — file-level ops on
 *   `<dataDir>/mmds/<filename>.mmd`.
 * `patchMmd` — incremental line-based replace blocks (sorted desc by start
 *   line to preserve indices during splicing). MmdReplaceBlock interface
 *   defines the block shape.
 */
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StorageContext } from "../storage-shim-types.js";

/** A single replace block for patchMmd */
export interface MmdReplaceBlock {
  /** 1-based start line number (inclusive) */
  startLine: number;
  /** 1-based end line number (inclusive). If endLine < startLine, treat as pure insertion */
  endLine: number;
  /** Replacement content (may contain newlines) */
  content: string;
}

/** Write/overwrite an MMD file */
export async function writeMmd(
  ctx: StorageContext,
  filename: string,
  content: string,
): Promise<void> {
  const filePath = join(ctx.mmdsDir, filename);
  await writeFile(filePath, content, "utf-8");
}

/** Apply incremental line-based replace blocks to an existing MMD file. */
export async function patchMmd(
  ctx: StorageContext,
  filename: string,
  blocks: MmdReplaceBlock[],
): Promise<boolean> {
  const filePath = join(ctx.mmdsDir, filename);
  const original = await readMmd(ctx, filename);
  if (original === null) return false;
  const lines = original.split("\n");
  let allValid = true;
  const sorted = [...blocks].sort((a, b) => b.startLine - a.startLine);
  for (const block of sorted) {
    const start = block.startLine;
    const end = block.endLine;
    if (start < 1 || start > lines.length + 1) {
      allValid = false;
      continue;
    }
    const newContentLines = block.content ? block.content.split("\n") : [];
    if (end < start) {
      lines.splice(start - 1, 0, ...newContentLines);
    } else {
      const clampedEnd = Math.min(end, lines.length);
      const deleteCount = clampedEnd - start + 1;
      lines.splice(start - 1, deleteCount, ...newContentLines);
    }
  }
  const newContent = lines.join("\n");
  if (newContent !== original) {
    await writeFile(filePath, newContent, "utf-8");
  }
  return allValid;
}

/** Read an MMD file */
export async function readMmd(
  ctx: StorageContext,
  filename: string,
): Promise<string | null> {
  const filePath = join(ctx.mmdsDir, filename);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

/** Delete an MMD file */
export async function deleteMmd(
  ctx: StorageContext,
  filename: string,
): Promise<boolean> {
  const filePath = join(ctx.mmdsDir, filename);
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}

/** List all MMD files in the mmds directory */
export async function listMmds(ctx: StorageContext): Promise<string[]> {
  if (!existsSync(ctx.mmdsDir)) return [];
  const files = await readdir(ctx.mmdsDir);
  return files.filter((f) => f.endsWith(".mmd")).sort();
}
