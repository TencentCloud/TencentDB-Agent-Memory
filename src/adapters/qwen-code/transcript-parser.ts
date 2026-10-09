import { createHash } from "node:crypto";
import type { QwenCodeCompletedTurn } from "./types.js";

interface ParsedTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  sourceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part)) {
          if (typeof part["text"] === "string") return part["text"];
          if (typeof part["content"] === "string") return part["content"];
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (isRecord(value)) {
    if (typeof value["text"] === "string") return value["text"];
    if (typeof value["content"] === "string") return value["content"];
    if (Array.isArray(value["parts"])) return textFromContent(value["parts"]);
  }
  return "";
}

function extractMessage(record: Record<string, unknown>, lineIndex: number): ParsedTranscriptMessage | null {
  const envelope = isRecord(record["message"]) ? record["message"] as Record<string, unknown> : record;
  const rawRole = envelope["role"] ?? record["role"] ?? record["type"];
  const role = rawRole === "user" || rawRole === "assistant" ? rawRole : undefined;
  if (!role) return null;

  const content = textFromContent(envelope["content"] ?? envelope["parts"] ?? envelope["text"]);
  if (!content.trim()) return null;

  const rawId = record["id"] ?? envelope["id"] ?? record["uuid"] ?? record["timestamp"] ?? lineIndex;
  return {
    role,
    content: content.trim(),
    sourceId: String(rawId),
  };
}

export function extractCompletedTurnsFromQwenTranscript(rawTranscript: string): QwenCodeCompletedTurn[] {
  const messages: ParsedTranscriptMessage[] = [];
  const lines = rawTranscript.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      const message = extractMessage(parsed, i);
      if (message) messages.push(message);
    } catch {
      // Qwen may be writing the trailing JSONL record while the hook runs.
    }
  }

  const turns: QwenCodeCompletedTurn[] = [];
  let pendingUser: ParsedTranscriptMessage | undefined;
  let pendingAssistantParts: ParsedTranscriptMessage[] = [];

  const flush = () => {
    if (!pendingUser || pendingAssistantParts.length === 0) return;
    const assistantText = pendingAssistantParts.map((message) => message.content).join("\n\n").trim();
    if (!assistantText) return;
    turns.push({
      userText: pendingUser.content,
      assistantText,
      sourceIds: [pendingUser.sourceId, ...pendingAssistantParts.map((message) => message.sourceId)],
    });
  };

  for (const message of messages) {
    if (message.role === "user") {
      flush();
      pendingUser = message;
      pendingAssistantParts = [];
      continue;
    }
    if (pendingUser) pendingAssistantParts.push(message);
  }
  flush();

  return turns;
}

export function getLatestCompletedQwenTurn(rawTranscript: string): QwenCodeCompletedTurn | undefined {
  return extractCompletedTurnsFromQwenTranscript(rawTranscript).at(-1);
}

export function hashQwenCodeTurn(turn: QwenCodeCompletedTurn): string {
  return createHash("sha256")
    .update(turn.userText)
    .update("\0")
    .update(turn.assistantText)
    .digest("hex");
}

