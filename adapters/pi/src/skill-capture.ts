import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillConversationMessage } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { createClients } from "./clients.js";
import { redactText, redactValue, truncateUtf8 } from "./security.js";
import type { LoadedConfig, SkillsOptions } from "./types.js";

const PENDING_VERSION = 1;
const PENDING_DIRECTORY = "tdai-memory-skills";

/**
 * One real tool interaction within a turn. `input` is the tool-call arguments
 * and `result` the execution outcome; both are redacted only when the turn is
 * normalised into Skill messages, never earlier, so the L0 path keeps its own
 * (coarser) evidence untouched.
 */
export interface SkillToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result?: {
    content: unknown;
    isError: boolean;
  };
}

export interface SkillTurnInput {
  prompt: string;
  finalAssistant: string;
  toolCalls: readonly SkillToolCall[];
  options: SkillsOptions;
}

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(value: unknown): value is TextBlock {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "text" &&
      typeof (value as { text?: unknown }).text === "string",
  );
}

function safeToolName(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned || "unknown";
}

function structuredText(value: unknown): string {
  const redacted = redactValue(value);
  if (typeof redacted === "string") return redacted;
  if (redacted === undefined || redacted === null) return "";
  try {
    return JSON.stringify(redacted);
  } catch {
    return "";
  }
}

function toolCallText(input: unknown, maxBytes: number): string {
  return truncateUtf8(structuredText(input), maxBytes);
}

function toolResultText(content: unknown, maxBytes: number): string {
  // Pi tool results are `(TextContent | ImageContent)[]`; images and other
  // binary blocks are dropped, only the textual evidence is worth learning.
  if (Array.isArray(content)) {
    const text = content
      .filter(isTextBlock)
      .map((part) => part.text)
      .join("\n")
      .trim();
    return truncateUtf8(redactText(text), maxBytes);
  }
  return truncateUtf8(redactText(structuredText(content)), maxBytes);
}

/**
 * Normalise a settled turn into the server's five-role conversation shape.
 *
 * Order follows the natural dialogue: user -> paired tool_call/tool_result ->
 * final assistant. Only complete pairs are emitted (a `tool_call` without a
 * `tool_result` is dropped, never padded with a fake success), and failed
 * tools are dropped by default. The memory/skill tools themselves are excluded
 * by the caller so their read-back never gets trained back into memory.
 */
export function createSkillMessages(input: SkillTurnInput): SkillConversationMessage[] {
  const { options } = input;
  const messages: SkillConversationMessage[] = [];

  const user = truncateUtf8(redactText(input.prompt.trim()), options.maxMessageBytes);
  if (user) messages.push({ role: "user", content: user });

  for (const call of input.toolCalls) {
    if (!call.result) continue; // incomplete pair: drop, never synthesise
    if (!options.includeFailedTools && call.result.isError) continue;
    const callContent = toolCallText(call.input, options.maxMessageBytes);
    const resultContent = toolResultText(call.result.content, options.maxMessageBytes);
    const toolName = safeToolName(call.toolName);
    messages.push({ role: "tool_call", content: callContent, tool_call_id: call.toolCallId, tool_name: toolName });
    messages.push({ role: "tool_result", content: resultContent, tool_call_id: call.toolCallId, tool_name: toolName });
  }

  const assistant = truncateUtf8(redactText(input.finalAssistant.trim()), options.maxMessageBytes);
  if (assistant) messages.push({ role: "assistant", content: assistant });

  return messages;
}

export type SkillDeliveryStatus = "delivered" | "archived" | "dead" | "uncertain";

interface SkillPendingRecord {
  version: typeof PENDING_VERSION;
  id: string;
  createdAt: string;
  scope: string;
  sessionId: string;
  messages: SkillConversationMessage[];
  uncertain?: boolean;
  lastError?: string;
}

export interface SkillTurnOptions {
  directory?: string;
  now?: () => Date;
}

async function defaultDirectory(): Promise<string> {
  // Lazy import so isolated test subprocesses never pull in the Pi runtime.
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return join(getAgentDir(), PENDING_DIRECTORY);
}

async function directoryFor(options: SkillTurnOptions): Promise<string> {
  return options.directory ?? (await defaultDirectory());
}

function scopeFor(config: LoadedConfig): string {
  return JSON.stringify({
    endpoint: config.endpoint,
    serviceId: config.serviceId,
    teamId: config.teamId,
    agentId: config.agentId,
    userId: config.userId,
  });
}

function classifyError(error: unknown): "dead" | "uncertain" {
  // `TDAMError` carries the server/business code; 4xx (HTTP) and 4xxxx
  // (business) are permanent and never become valid on retry. Everything else
  // — 5xx, 429, timeout, connection loss — is ambiguous: the server may have
  // already appended this batch, so it is NOT retried automatically.
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "number" && ((code >= 400 && code < 500) || (code >= 40_000 && code < 50_000))) {
    return "dead";
  }
  return "uncertain";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeRecord(path: string, record: SkillPendingRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("skill delivery timed out")), timeoutMs);
    }),
  ]).finally(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  });
}

/**
 * Persist and deliver one turn's Skill conversation exactly once.
 *
 * The record is written to disk first so a crash before the network request
 * never loses the turn. The request is then sent a single time:
 *   - `ok` / `archived` -> record removed;
 *   - deterministic 4xx  -> record quarantined as `.dead`;
 *   - anything ambiguous (5xx, timeout, dropped connection) -> record kept
 *     with an `uncertain` marker for a human to inspect, never re-sent.
 *
 * This is the opposite of the L0 outbox: the server's conversation buffer and
 * `tool_call` counter accumulate across batches, so a blind retry of a batch
 * the server already accepted would double-append it and archive early.
 */
export async function enqueueSkillTurn(
  config: LoadedConfig,
  sessionId: string,
  messages: SkillConversationMessage[],
  options: SkillTurnOptions = {},
): Promise<SkillDeliveryStatus> {
  if (messages.length === 0) return "delivered";

  const directory = await directoryFor(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const now = options.now?.() ?? new Date();
  const record: SkillPendingRecord = {
    version: PENDING_VERSION,
    id: randomUUID(),
    createdAt: now.toISOString(),
    scope: scopeFor(config),
    sessionId,
    messages,
  };
  const target = join(directory, `${record.createdAt.replaceAll(":", "-")}-${record.id}.json`);
  await writeRecord(target, record);

  try {
    const skill = createClients(config).skill;
    const result = await settleWithin(
      skill.conversationAdd({
        session_id: sessionId,
        user_id: config.userId,
        team_id: config.teamId,
        agent_id: config.agentId,
        messages,
      }),
      config.skills.flushTimeoutMs,
    );
    await rm(target, { force: true });
    return result.status === "archived" ? "archived" : "delivered";
  } catch (error) {
    if (classifyError(error) === "dead") {
      await rename(target, `${target}.dead`).catch(() => undefined);
      return "dead";
    }
    await writeRecord(target, { ...record, uncertain: true, lastError: safeMessage(error) });
    return "uncertain";
  }
}
