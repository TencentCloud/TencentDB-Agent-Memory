import fs from "node:fs";
import type { ClaudeCodeSeedMessage, ClaudeCodeSeedSession } from "../types.js";

interface TranscriptRecord {
  type?: string;
  timestamp?: number | string;
  message?: {
    role?: string;
    content?: unknown;
  };
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

function parseJsonl(content: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as TranscriptRecord);
    } catch {
      // Best-effort import: skip corrupt lines, keep later valid rounds.
    }
  }
  return records;
}

function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const obj = block as Record<string, unknown>;
  if (obj.type !== "text") return "";
  return typeof obj.text === "string" ? obj.text : "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(blockText)
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

function normalizeRecord(record: TranscriptRecord): ClaudeCodeSeedMessage | undefined {
  const role = record.message?.role ?? record.role ?? record.type;
  if (role !== "user" && role !== "assistant") return undefined;

  const content = extractText(record.message?.content ?? record.content);
  if (!content) return undefined;

  return {
    role,
    content,
    timestamp: record.timestamp,
  };
}

export function transcriptRecordsToSeedSession(input: {
  records: TranscriptRecord[];
  sessionKey: string;
  sessionId?: string;
}): ClaudeCodeSeedSession {
  const conversations: ClaudeCodeSeedMessage[][] = [];
  let pendingUser: ClaudeCodeSeedMessage | undefined;

  for (const record of input.records) {
    const message = normalizeRecord(record);
    if (!message) continue;

    if (message.role === "user") {
      pendingUser = message;
      continue;
    }

    if (pendingUser) {
      conversations.push([pendingUser, message]);
      pendingUser = undefined;
    }
  }

  return {
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    conversations,
  };
}

export function parseClaudeCodeTranscriptFile(input: {
  transcriptPath: string;
  sessionKey: string;
  sessionId?: string;
}): ClaudeCodeSeedSession {
  const content = fs.readFileSync(input.transcriptPath, "utf-8");
  return transcriptRecordsToSeedSession({
    records: parseJsonl(content),
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
  });
}
