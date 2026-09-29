/**
 * 待投递存储：为 Cursor stop 事件追加 JSONL，并折叠 transcript。
 * 边界仅限本地 pending 文件和有界 transcript 读取，不访问网络或启动 worker。
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

interface PendingBase {
  v: 1;
  conversation_id: string;
  generation_id: string;
  at_ms: number;
}

export interface PendingUserEvent extends PendingBase {
  event: "user";
  text: string;
}

export interface PendingAssistantEvent extends PendingBase {
  event: "assistant";
  text: string;
}

export interface PendingStopEvent extends PendingBase {
  event: "stop";
  status: string;
}

export type PendingEvent =
  | PendingUserEvent
  | PendingAssistantEvent
  | PendingStopEvent;

export interface FoldedCapture {
  conversationId: string;
  userContent: string;
  assistantContent: string;
}

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

export function pendingKey(conversationId: string, generationId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([conversationId, generationId]), "utf8")
    .digest("hex");
}

export function pendingPath(
  rootDir: string,
  conversationId: string,
  generationId: string,
): string {
  return path.join(
    rootDir,
    "pending",
    `${pendingKey(conversationId, generationId)}.jsonl`,
  );
}

export async function appendPendingEvent(
  rootDir: string,
  event: PendingEvent,
): Promise<string> {
  return appendPendingEvents(rootDir, [event]);
}

export async function appendPendingEvents(
  rootDir: string,
  events: PendingEvent[],
): Promise<string> {
  if (events.length === 0) throw new Error("pending events are empty");
  const [first] = events;
  if (!events.every(
    (event) =>
      event.conversation_id === first.conversation_id &&
      event.generation_id === first.generation_id,
  )) {
    throw new Error("pending events use different identifiers");
  }
  const filePath = pendingPath(
    rootDir,
    first.conversation_id,
    first.generation_id,
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });

  // 整轮编码为一个 Buffer，并通过单次 O_APPEND 写入。
  const line = Buffer.from(
    `\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  const handle = await open(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    0o600,
  );
  try {
    const result = await handle.write(line, 0, line.length, null);
    if (result.bytesWritten !== line.length) {
      throw new Error(
        `short append: wrote ${result.bytesWritten} of ${line.length} bytes`,
      );
    }
  } finally {
    await handle.close();
  }
  return filePath;
}

interface TranscriptRecord {
  role?: unknown;
  type?: unknown;
  message?: {
    content?: unknown;
  };
}

function transcriptTextParts(record: TranscriptRecord): string[] {
  if (!Array.isArray(record.message?.content)) return [];
  return record.message.content.flatMap((item) => {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "text" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      return [(item as Record<string, unknown>).text as string];
    }
    return [];
  });
}

function extractUserQuery(text: string): string | undefined {
  const openTag = "<user_query>\n";
  const closeTag = "\n</user_query>";
  const start = text.indexOf(openTag);
  const end = text.lastIndexOf(closeTag);
  if (start < 0 || end < start + openTag.length) return undefined;
  return text.slice(start + openTag.length, end);
}

export function extractTranscriptTurn(
  content: string,
): Pick<FoldedCapture, "userContent" | "assistantContent"> | undefined {
  const records = content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as TranscriptRecord;
      return parsed && typeof parsed === "object" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const end = records.findLastIndex((record) => record.type === "turn_ended");
  if (end < 0) return undefined;
  if (
    records
      .slice(end + 1)
      .some((record) => record.role === "user" || record.role === "assistant")
  ) {
    return undefined;
  }
  const previousEnd = records
    .slice(0, end)
    .findLastIndex((record) => record.type === "turn_ended");
  const turn = records.slice(previousEnd + 1, end);

  const userContent = turn
    .filter((record) => record.role === "user")
    .flatMap(transcriptTextParts)
    .map(extractUserQuery)
    .findLast((text) => text !== undefined);
  const assistantContent = turn
    .filter((record) => record.role === "assistant")
    .flatMap(transcriptTextParts)
    .filter((text) => text.trim())
    .at(-1);

  if (!userContent?.trim() || !assistantContent?.trim()) return undefined;
  return { userContent, assistantContent };
}

export async function appendTranscriptTurn(
  rootDir: string,
  transcriptsRoot: string,
  transcriptPath: string,
  conversationId: string,
  generationId: string,
  status: string,
  atMs: number,
): Promise<string> {
  const [resolvedRoot, resolvedTranscriptPath] = await Promise.all([
    realpath(transcriptsRoot),
    realpath(transcriptPath),
  ]);
  const relative = path.relative(resolvedRoot, resolvedTranscriptPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("transcript path is outside transcript root");
  }
  if (!relative.split(path.sep).includes("agent-transcripts")) {
    throw new Error("transcript path is outside agent-transcripts");
  }
  const transcriptHandle = await open(resolvedTranscriptPath, constants.O_RDONLY);
  let transcript: string;
  try {
    const before = await transcriptHandle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("transcript is not a regular file");
    if (before.size > BigInt(MAX_TRANSCRIPT_BYTES)) {
      throw new Error(`transcript is too large: ${before.size} bytes`);
    }
    const expectedSize = Number(before.size);
    const buffer = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await transcriptHandle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await transcriptHandle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      offset !== expectedSize
    ) {
      throw new Error("transcript changed while reading");
    }
    transcript = buffer.toString("utf8");
  } finally {
    await transcriptHandle.close();
  }
  const turn = extractTranscriptTurn(transcript);
  if (!turn) throw new Error("transcript has no complete turn");
  return appendPendingEvents(rootDir, [
    {
      v: 1,
      event: "user",
      conversation_id: conversationId,
      generation_id: generationId,
      text: turn.userContent,
      at_ms: atMs,
    },
    {
      v: 1,
      event: "assistant",
      conversation_id: conversationId,
      generation_id: generationId,
      text: turn.assistantContent,
      at_ms: atMs,
    },
    {
      v: 1,
      event: "stop",
      conversation_id: conversationId,
      generation_id: generationId,
      status,
      at_ms: atMs,
    },
  ]);
}

function parseEvent(line: string): PendingEvent | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      value.v !== 1 ||
      typeof value.event !== "string" ||
      typeof value.conversation_id !== "string" ||
      typeof value.generation_id !== "string" ||
      typeof value.at_ms !== "number"
    ) {
      return undefined;
    }
    if (
      (value.event === "user" || value.event === "assistant") &&
      typeof value.text === "string"
    ) {
      return value as unknown as PendingUserEvent | PendingAssistantEvent;
    }
    if (value.event === "stop" && typeof value.status === "string") {
      return value as unknown as PendingStopEvent;
    }
  } catch {
    // 截断或损坏的行只影响自身。
  }
  return undefined;
}

export function foldPending(content: string): FoldedCapture | undefined {
  let user: PendingUserEvent | undefined;
  const assistants: string[] = [];
  let stopped = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseEvent(line);
    if (!event || stopped) continue;

    if (event.event === "user") {
      if (!user && event.text.trim()) user = event;
      continue;
    }
    if (
      !user ||
      event.conversation_id !== user.conversation_id ||
      event.generation_id !== user.generation_id
    ) {
      continue;
    }
    if (event.event === "assistant") {
      if (event.text.trim()) assistants.push(event.text);
      continue;
    }
    if (event.event === "stop") stopped = true;
  }

  if (!user || !stopped || assistants.length === 0) return undefined;
  return {
    conversationId: user.conversation_id,
    userContent: user.text,
    assistantContent: assistants.join("\n\n"),
  };
}
