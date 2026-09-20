/**
 * Claude Code transcript → L0 messages.
 *
 * Claude Code writes every session as JSONL under its projects directory and
 * names the file in each hook payload (`transcript_path`). This module turns
 * the entries after a marker into v3 conversation items: prompts, tool calls,
 * tool results, intermediate and final assistant text. The Gateway records
 * what it is sent, so exclusion of already-captured turns and redaction of
 * credential-shaped text both happen here.
 */

import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TranscriptContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

export interface TranscriptEntry {
  uuid: string;
  type: "user" | "assistant";
  promptId?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message: {
    role?: string;
    content?: string | TranscriptContentBlock[];
  };
}

export interface TranscriptMessage {
  /** Stable id: `claude-code:<session>:<entry uuid>[#chunk]`. */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp of the transcript entry, when it carries one. */
  timestamp?: string;
  /** Transcript entry the message came from; the capture marker records the last one sent. */
  sourceUuid: string;
}

export interface NormalizeTranscriptOptions {
  sessionId: string;
  /** Prompt ids whose prompt + final assistant text were already captured by the plain path. */
  capturedPromptIds?: Set<string>;
  chunkChars?: number;
  toolInputMaxChars?: number;
  toolResultMaxChars?: number;
}

export const DEFAULT_CHUNK_CHARS = 8_192;
export const DEFAULT_TOOL_INPUT_MAX_CHARS = 2_000;
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 4_000;
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Credential shapes that tool traffic routinely carries (env dumps, config
 * files, curl commands). Each match becomes `[redacted:<kind>]`; surrounding
 * text stays so the event is still legible.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private-key"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "authorization"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "secret-key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "github-token"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "gitlab-token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "slack-token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "google-api-key"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "npm-token"],
  [/\b[a-z]+_[0-9a-f]{40,}\b/g, "token"],
  [/\b((?:api[_-]?key|api[_-]?token|access[_-]?token|secret|password|passwd|pwd)\s*[=:]\s*["']?)([^\s"'&]{8,})/gi, "value"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, kind] of SECRET_PATTERNS) {
    out = kind === "value"
      ? out.replace(pattern, (_match, key: string) => `${key}[redacted:${kind}]`)
      : out.replace(pattern, `[redacted:${kind}]`);
  }
  return out;
}

export async function readTranscriptEntries(transcriptPath: string): Promise<TranscriptEntry[]> {
  const raw = await readFile(transcriptPath, "utf-8");
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as Partial<TranscriptEntry>;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (typeof entry.uuid !== "string" || !entry.message || typeof entry.message !== "object") continue;
    if (entry.isSidechain === true || entry.isMeta === true) continue;
    entries.push(entry as TranscriptEntry);
  }
  return entries;
}

export function sliceAfter(entries: TranscriptEntry[], afterUuid: string | undefined): TranscriptEntry[] {
  if (!afterUuid) return entries;
  const index = entries.findIndex((entry) => entry.uuid === afterUuid);
  return index === -1 ? entries : entries.slice(index + 1);
}

export function promptIdsIn(entries: TranscriptEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "user" && entry.promptId && isPromptEntry(entry) && !seen.has(entry.promptId)) {
      seen.add(entry.promptId);
    }
  }
  return [...seen];
}

interface Part {
  text: string;
  prose: boolean;
}

/**
 * Policy: thinking and images dropped; a tool call becomes assistant text
 * `[tool_use …]`; a tool result becomes user text `[tool_result …]`; long
 * content chunked. For a turn in `capturedPromptIds` the prompt and the final
 * assistant prose are left out; its tool traffic stays.
 */
export function normalizeTranscript(entries: TranscriptEntry[], options: NormalizeTranscriptOptions): TranscriptMessage[] {
  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const toolInputMax = options.toolInputMaxChars ?? DEFAULT_TOOL_INPUT_MAX_CHARS;
  const toolResultMax = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const captured = options.capturedPromptIds ?? new Set<string>();

  interface Draft {
    entry: TranscriptEntry;
    role: "user" | "assistant";
    parts: Part[];
    prompt: boolean;
    promptId?: string;
  }

  const drafts: Draft[] = [];
  let currentPromptId: string | undefined;

  for (const entry of entries) {
    const content = entry.message.content;
    if (entry.type === "user") {
      const parts: Part[] = [];
      if (typeof content === "string") {
        parts.push({ text: content, prose: true });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            parts.push({ text: block.text, prose: true });
          } else if (block.type === "tool_result") {
            const body = clip(blockText(block.content), toolResultMax);
            parts.push({ text: `[tool_result tool_use_id=${block.tool_use_id ?? ""}] ${body}`.trim(), prose: false });
          }
        }
      }
      const prompt = isPromptEntry(entry);
      if (prompt) currentPromptId = entry.promptId;
      drafts.push({ entry, role: "user", parts, prompt, promptId: prompt ? entry.promptId : currentPromptId });
    } else {
      const parts: Part[] = [];
      if (typeof content === "string") {
        parts.push({ text: content, prose: true });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            parts.push({ text: block.text, prose: true });
          } else if (block.type === "tool_use") {
            const input = clip(safeJson(block.input ?? {}), toolInputMax);
            parts.push({ text: `[tool_use id=${block.id ?? ""} name=${block.name ?? ""} input=${input}]`, prose: false });
          }
        }
      }
      drafts.push({ entry, role: "assistant", parts, prompt: false, promptId: currentPromptId });
    }
  }

  const finalProseIndex = new Set<number>();
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    if (!draft.promptId || !captured.has(draft.promptId)) continue;
    if (draft.role !== "assistant" || !draft.parts.some((part) => part.prose && part.text.trim())) continue;
    let last = true;
    for (let j = i + 1; j < drafts.length; j += 1) {
      if (drafts[j].prompt) break;
      if (drafts[j].role === "assistant" && drafts[j].parts.some((part) => part.prose && part.text.trim())) {
        last = false;
        break;
      }
    }
    if (last) finalProseIndex.add(i);
  }

  const messages: TranscriptMessage[] = [];
  drafts.forEach((draft, index) => {
    let parts = draft.parts;
    if (draft.promptId && captured.has(draft.promptId)) {
      if (draft.prompt) return;
      if (finalProseIndex.has(index)) parts = parts.filter((part) => !part.prose);
    }
    const text = redactSecrets(parts.map((part) => part.text).filter((part) => part.trim()).join("\n").trim());
    if (!text) return;
    const base = `claude-code:${options.sessionId}:${draft.entry.uuid}`;
    const timestamp = typeof draft.entry.timestamp === "string" ? draft.entry.timestamp : undefined;
    chunk(text, chunkChars).forEach((piece, chunkIndex) => {
      messages.push({
        id: chunkIndex === 0 ? base : `${base}#${chunkIndex}`,
        role: draft.role,
        content: piece,
        ...(timestamp ? { timestamp } : {}),
        sourceUuid: draft.entry.uuid,
      });
    });
  });
  return messages;
}

export function splitBatches<T>(messages: T[], size = DEFAULT_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < messages.length; i += size) batches.push(messages.slice(i, i + size));
  return batches;
}

/**
 * Claude Code passes `transcript_path` in every hook payload. When absent, the
 * file is looked up under the projects directory, whose per-project folder is
 * the cwd with every non-alphanumeric character replaced by `-`.
 */
export async function resolveTranscriptPath(input: {
  transcriptPath?: string;
  cwd?: string;
  sessionId: string;
  claudeConfigDir?: string;
}): Promise<string | undefined> {
  if (input.transcriptPath && await exists(input.transcriptPath)) return input.transcriptPath;
  if (!input.cwd) return undefined;
  const configDir = input.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const candidate = path.join(configDir, "projects", input.cwd.replace(/[^A-Za-z0-9]/g, "-"), `${input.sessionId}.jsonl`);
  return await exists(candidate) ? candidate : undefined;
}

export function isPromptEntry(entry: TranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const hasText = content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
  const hasToolResult = content.some((block) => block?.type === "tool_result");
  return hasText && !hasToolResult;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const b = block as TranscriptContentBlock;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") return "";
        return safeJson(block);
      })
      .filter((text) => text.trim())
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return safeJson(content);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

function chunk(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
