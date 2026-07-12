import fs from "node:fs";
import { CodingAgentGatewayClient } from "../coding-agent/index.js";
import type {
  CodingAgentGatewayClientOptions,
  CodingAgentRecallRequest,
  CodingAgentTurn,
} from "../coding-agent/index.js";

export interface ClaudeCodeHookInput {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  prompt_id?: string;
  promptId?: string;
  transcript_path?: string;
  transcriptPath?: string;
  cwd?: string;
  prompt?: string;
  message?: unknown;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  stop_hook_active?: boolean;
  stopHookActive?: boolean;
  reason?: string;
}

export interface ClaudeCodeHookClient {
  health(): Promise<unknown>;
  recall(request: CodingAgentRecallRequest): Promise<{
    context?: string;
    prepend_context?: string;
    append_system_context?: string;
  }>;
  capture(turn: CodingAgentTurn): Promise<unknown>;
  endSession(sessionKey: string): Promise<unknown>;
}

export interface ClaudeCodeHookOptions {
  client?: ClaudeCodeHookClient;
  gateway?: CodingAgentGatewayClientOptions;
}

export interface ClaudeCodeHookResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface TranscriptTurn {
  userContent: string;
  assistantContent: string;
  userTimestamp?: number;
  assistantTimestamp?: number;
}

export async function handleClaudeCodeHook(
  input: ClaudeCodeHookInput,
  options: ClaudeCodeHookOptions = {},
): Promise<ClaudeCodeHookResult> {
  const client = options.client ?? new CodingAgentGatewayClient(options.gateway);
  const eventName = getEventName(input);

  try {
    if (eventName === "UserPromptSubmit") {
      return await handleUserPromptSubmit(input, client);
    }
    if (eventName === "Stop") {
      return await handleStop(input, client);
    }
    if (eventName === "SessionEnd") {
      const sessionKey = buildSessionKey(input);
      if (sessionKey) await client.endSession(sessionKey);
      return { exitCode: 0 };
    }
    if (eventName === "SessionStart") {
      await client.health();
      return { exitCode: 0 };
    }
    return { exitCode: 0 };
  } catch (err) {
    return {
      exitCode: 0,
      stderr: `tdai claude-code hook skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function handleUserPromptSubmit(
  input: ClaudeCodeHookInput,
  client: ClaudeCodeHookClient,
): Promise<ClaudeCodeHookResult> {
  const query = extractPrompt(input);
  const sessionKey = buildSessionKey(input);
  if (!query || !sessionKey) return { exitCode: 0 };

  const result = await client.recall({
    query,
    sessionKey,
  });

  const context = combineRecallContext(result);
  if (!context) return { exitCode: 0 };

  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    }),
  };
}

async function handleStop(
  input: ClaudeCodeHookInput,
  client: ClaudeCodeHookClient,
): Promise<ClaudeCodeHookResult> {
  const turn = extractLatestTurn(input);
  const sessionKey = buildSessionKey(input);
  if (turn && sessionKey) {
    const hasTimestamps = turn.userTimestamp !== undefined && turn.assistantTimestamp !== undefined;
    await client.capture({
      userContent: turn.userContent,
      assistantContent: turn.assistantContent,
      sessionKey,
      sessionId: getSessionId(input),
      ...(hasTimestamps ? {
        messages: [
          { role: "user", content: turn.userContent, timestamp: turn.userTimestamp },
          { role: "assistant", content: turn.assistantContent, timestamp: turn.assistantTimestamp },
        ],
        startedAt: Math.max(0, turn.userTimestamp! - 1),
      } : {}),
    });
  }

  return { exitCode: 0 };
}

export function buildSessionKey(input: ClaudeCodeHookInput): string | null {
  const sessionId = getSessionId(input);
  return sessionId ? `claude-code:${sessionId}` : null;
}

export function extractLatestTurn(input: ClaudeCodeHookInput): TranscriptTurn | null {
  const transcriptPath = input.transcript_path ?? input.transcriptPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let latestUser = "";
  let latestCompletedTurn: TranscriptTurn | null = null;
  let latestUserTimestamp: number | undefined;
  let lastAssistantRow = -1;
  let lastToolResultRow = -1;
  const targetPromptId = getPromptId(input);

  const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
  for (const [rowIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const record = typeof row === "object" && row !== null
      ? row as Record<string, unknown>
      : undefined;
    if (!record || record.isMeta === true || record.isSidechain === true) continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const role = (message as Record<string, unknown>).role;
    const rawContent = (message as Record<string, unknown>).content;
    if (
      role === "user" &&
      (containsToolResult(rawContent) || record.sourceToolAssistantUUID !== undefined)
    ) {
      lastToolResultRow = rowIndex;
      continue;
    }
    const content = contentToText(rawContent);
    if (!content) continue;
    if (role === "user") {
      if (targetPromptId && getTranscriptPromptId(record) !== targetPromptId) continue;
      latestUser = content;
      latestUserTimestamp = parseTranscriptTimestamp(record.timestamp);
    } else if (role === "assistant" && latestUser) {
      const assistantTimestamp = parseTranscriptTimestamp(record.timestamp);
      latestCompletedTurn = {
        userContent: latestUser,
        assistantContent: content,
        ...(latestUserTimestamp !== undefined ? { userTimestamp: latestUserTimestamp } : {}),
        ...(assistantTimestamp !== undefined ? { assistantTimestamp } : {}),
      };
      lastAssistantRow = rowIndex;
    }
  }

  const currentAssistant = getLastAssistantMessage(input);
  if (latestUser && currentAssistant) {
    const completedTimestamp = latestCompletedTurn?.userContent === latestUser
      ? latestCompletedTurn.assistantTimestamp
      : undefined;
    const assistantTimestamp = completedTimestamp ?? (
      latestUserTimestamp !== undefined ? latestUserTimestamp + 1 : undefined
    );
    return {
      userContent: latestUser,
      assistantContent: currentAssistant,
      ...(latestUserTimestamp !== undefined ? { userTimestamp: latestUserTimestamp } : {}),
      ...(assistantTimestamp !== undefined ? { assistantTimestamp } : {}),
    };
  }
  if (
    !latestCompletedTurn ||
    latestCompletedTurn.userContent !== latestUser ||
    lastToolResultRow > lastAssistantRow
  ) {
    return null;
  }
  return latestCompletedTurn;
}

function getEventName(input: ClaudeCodeHookInput): string {
  return input.hook_event_name ?? input.hookEventName ?? "";
}

function getSessionId(input: ClaudeCodeHookInput): string {
  return input.session_id ?? input.sessionId ?? "";
}

function getPromptId(input: ClaudeCodeHookInput): string {
  return input.prompt_id ?? input.promptId ?? "";
}

function getTranscriptPromptId(record: Record<string, unknown>): string {
  const value = record.promptId ?? record.prompt_id;
  return typeof value === "string" ? value : "";
}

function parseTranscriptTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function extractPrompt(input: ClaudeCodeHookInput): string {
  if (typeof input.prompt === "string") return input.prompt;
  return contentToText(input.message);
}

function getLastAssistantMessage(input: ClaudeCodeHookInput): string {
  const value = input.last_assistant_message ?? input.lastAssistantMessage;
  return typeof value === "string" ? value.trim() : "";
}

function combineRecallContext(result: {
  context?: string;
  prepend_context?: string;
  append_system_context?: string;
}): string {
  const dynamicContext = result.prepend_context?.trim();
  const stableContext = (result.append_system_context ?? result.context)
    ?.replace(/<memory-tools-guide>[\s\S]*?<\/memory-tools-guide>/gi, "")
    .trim();
  return [...new Set([dynamicContext, stableContext].filter((value): value is string => !!value))]
    .join("\n\n");
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";

  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (record.type !== undefined && record.type !== "text") return "";
      if (typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function containsToolResult(value: unknown): boolean {
  return Array.isArray(value) && value.some((part) => (
    !!part && typeof part === "object" && (part as Record<string, unknown>).type === "tool_result"
  ));
}
