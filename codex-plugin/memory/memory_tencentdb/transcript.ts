import { readFile } from "node:fs/promises";

export interface TranscriptTurn {
  userText: string;
  assistantText: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map(textFromContent).filter(Boolean).join("\n").trim();
  }
  if (!content || typeof content !== "object") return "";

  const value = content as Record<string, unknown>;
  if (typeof value.text === "string") return value.text.trim();
  return textFromContent(value.content);
}

function messageFromRecord(record: unknown): { role: string; text: string } | null {
  if (!record || typeof record !== "object") return null;
  const root = record as Record<string, unknown>;
  const candidates = [
    root,
    root.payload,
    root.message,
    root.payload && typeof root.payload === "object"
      ? (root.payload as Record<string, unknown>).message
      : undefined,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    if (value.role !== "user" && value.role !== "assistant") continue;
    const text = textFromContent(value.content);
    if (text) return { role: value.role, text };
  }
  return null;
}

export async function readLatestTranscriptTurn(
  transcriptPath: string,
): Promise<TranscriptTurn | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let currentUser = "";
  let latest: TranscriptTurn | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = messageFromRecord(JSON.parse(line));
      if (!message) continue;
      if (message.role === "user") {
        currentUser = message.text;
      } else if (currentUser) {
        latest = { userText: currentUser, assistantText: message.text };
      }
    } catch {
      // Ignore malformed or unrelated transcript records.
    }
  }
  return latest;
}
