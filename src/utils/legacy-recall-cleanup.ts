/**
 * Legacy recall-injection cleanup for OpenClaw session JSONL history.
 *
 * Runtime hooks already prevent new <relevant-memories> blocks from being
 * persisted, but transcripts written before that fix can still contain them.
 * Keeping those blocks in history makes each replayed turn longer and makes
 * the stable prefix unstable for OpenAI-compatible prefix caches, so this
 * module provides a safe, offline cleanup pass for existing session files.
 */

import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawStateDir } from "./openclaw-state-dir.js";
import type { OpenClawRuntimeStateLike } from "./openclaw-state-dir.js";

export const RELEVANT_MEMORIES_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

export interface ContentCleanResult {
  content: unknown;
  changed: boolean;
  blocksRemoved: number;
}

export interface LineCleanResult {
  line: string;
  changed: boolean;
  blocksRemoved: number;
  malformed: boolean;
}

export interface FileCleanResult {
  file: string;
  changed: boolean;
  linesScanned: number;
  linesChanged: number;
  blocksRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesRemoved: number;
  malformedLines: number;
}

export interface CleanSummary {
  stateDir: string;
  dryRun: boolean;
  filesScanned: number;
  filesChanged: number;
  linesScanned: number;
  linesChanged: number;
  blocksRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesRemoved: number;
  malformedLines: number;
  changedFiles: string[];
}

export interface RunCleanupOptions {
  /** OpenClaw state directory; defaults to OPENCLAW_STATE_DIR or ~/.openclaw. */
  stateDir?: string;
  /** When true, report without rewriting files. Defaults to true. */
  dryRun?: boolean;
  /** Optional runtime state dir resolver used for the default path. */
  runtimeState?: OpenClawRuntimeStateLike;
}

function countBlocks(text: string): number {
  return text.match(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g)?.length ?? 0;
}

export function stripRelevantMemories(text: string): string {
  if (!text.includes("<relevant-memories>")) return text;
  const cleaned = text.replace(RELEVANT_MEMORIES_RE, "");
  if (cleaned === text) return text;
  return cleaned.trim();
}

export function cleanUserContent(content: unknown): ContentCleanResult {
  if (typeof content === "string") {
    const cleaned = stripRelevantMemories(content);
    return {
      content: cleaned,
      changed: cleaned !== content,
      blocksRemoved: cleaned === content ? 0 : countBlocks(content),
    };
  }

  if (Array.isArray(content)) {
    let changed = false;
    let blocksRemoved = 0;
    const parts = content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const record = part as Record<string, unknown>;
      if (record.type !== "text" || typeof record.text !== "string") return part;
      const cleaned = stripRelevantMemories(record.text);
      if (cleaned === record.text) return part;
      changed = true;
      blocksRemoved += countBlocks(record.text);
      return { ...record, text: cleaned };
    });
    return {
      content: changed ? parts : content,
      changed,
      blocksRemoved,
    };
  }

  return { content, changed: false, blocksRemoved: 0 };
}

export function cleanSessionJsonlLine(rawLine: string): LineCleanResult {
  if (!rawLine.includes("<relevant-memories>")) {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: true };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: false };
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "message") {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: false };
  }

  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: false };
  }

  const msg = message as Record<string, unknown>;
  if (msg.role !== "user") {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: false };
  }

  const cleaned = cleanUserContent(msg.content);
  if (!cleaned.changed) {
    return { line: rawLine, changed: false, blocksRemoved: 0, malformed: false };
  }

  return {
    line: JSON.stringify({ ...record, message: { ...msg, content: cleaned.content } }),
    changed: true,
    blocksRemoved: cleaned.blocksRemoved,
    malformed: false,
  };
}

export function isSessionFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (!base.endsWith(".jsonl") || base.endsWith(".trajectory.jsonl") || base.startsWith(".")) {
    return false;
  }
  const parts = filePath.split(path.sep);
  return parts.includes("agents") && parts.at(-2) === "sessions";
}

export async function findSessionFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  await walkSessionFiles(rootDir, found);
  return found.sort();
}

async function walkSessionFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSessionFiles(fullPath, out);
    } else if (entry.isFile() && isSessionFile(fullPath)) {
      out.push(fullPath);
    }
  }
}

export async function cleanSessionFile(filePath: string, dryRun: boolean): Promise<FileCleanResult> {
  const raw = await readFile(filePath, "utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = raw.split(/\r?\n/);
  const outputLines: string[] = [];
  let changed = false;
  let linesChanged = 0;
  let blocksRemoved = 0;
  let malformedLines = 0;

  for (const line of rawLines) {
    const result = cleanSessionJsonlLine(line);
    if (result.malformed) malformedLines += 1;
    if (result.changed) {
      changed = true;
      linesChanged += 1;
      blocksRemoved += result.blocksRemoved;
    }
    outputLines.push(result.line);
  }

  const output = outputLines.join(newline);
  const bytesBefore = Buffer.byteLength(raw, "utf8");
  const bytesAfter = Buffer.byteLength(output, "utf8");

  if (changed && !dryRun) {
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.tdai-clean-${process.pid}-${Date.now()}.tmp`,
    );
    await writeFile(tmpPath, output, "utf8");
    try {
      await rename(tmpPath, filePath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        // Best-effort temp cleanup; the original error is more useful.
      }
      throw err;
    }
  }

  return {
    file: filePath,
    changed,
    linesScanned: rawLines.length,
    linesChanged,
    blocksRemoved,
    bytesBefore,
    bytesAfter,
    bytesRemoved: bytesBefore - bytesAfter,
    malformedLines,
  };
}

export async function runLegacyRecallCleanup(options: RunCleanupOptions = {}): Promise<CleanSummary> {
  const stateDir = options.stateDir ?? resolveOpenClawStateDir(options.runtimeState);
  const dryRun = options.dryRun ?? true;
  const files = await findSessionFiles(stateDir);
  const changedFiles: string[] = [];
  let filesChanged = 0;
  let linesScanned = 0;
  let linesChanged = 0;
  let blocksRemoved = 0;
  let malformedLines = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const file of files) {
    const result = await cleanSessionFile(file, dryRun);
    linesScanned += result.linesScanned;
    malformedLines += result.malformedLines;
    bytesBefore += result.bytesBefore;
    bytesAfter += result.bytesAfter;
    if (result.changed) {
      filesChanged += 1;
      linesChanged += result.linesChanged;
      blocksRemoved += result.blocksRemoved;
      changedFiles.push(file);
    }
  }

  return {
    stateDir,
    dryRun,
    filesScanned: files.length,
    filesChanged,
    linesScanned,
    linesChanged,
    blocksRemoved,
    bytesBefore,
    bytesAfter,
    bytesRemoved: bytesBefore - bytesAfter,
    malformedLines,
    changedFiles,
  };
}

export function formatCleanSummary(summary: CleanSummary): string {
  const lines = [
    `Scanned ${summary.filesScanned} OpenClaw session file(s) under: ${summary.stateDir}`,
    summary.dryRun
      ? "Dry-run mode: no files were changed. Re-run with --yes to apply."
      : `Cleaned ${summary.filesChanged} file(s).`,
    `- lines scanned: ${summary.linesScanned}`,
    `- lines changed: ${summary.linesChanged}`,
    `- <relevant-memories> blocks removed: ${summary.blocksRemoved}`,
    `- bytes before: ${summary.bytesBefore}`,
    `- bytes after: ${summary.bytesAfter}`,
    `- bytes removed: ${summary.bytesRemoved}`,
  ];
  if (summary.malformedLines > 0) {
    lines.push(`- malformed JSONL lines left untouched: ${summary.malformedLines}`);
  }
  if (!summary.dryRun && summary.changedFiles.length > 0) {
    lines.push("Changed files:");
    for (const file of summary.changedFiles) lines.push(`  ${file}`);
  }
  return `${lines.join("\n")}\n`;
}