import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { redactText, truncateUtf8 } from "./security.js";

const MAX_RESULT_BYTES = 12_000;

export interface MemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
}

export interface ConversationSearchParams {
  query: string;
  limit?: number;
  session_key?: string;
}

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: truncateUtf8(redactText(text), MAX_RESULT_BYTES) }], details };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function score(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

export async function memorySearch(
  memory: MemoryClient,
  params: MemorySearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const query = params.query.trim();
  if (!query) return textResult("Query cannot be empty.");
  try {
    const request = {
      query,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      ...(params.type === undefined ? {} : { type: params.type }),
    };
    const result = await memory.searchAtomic(request);
    if (result.items.length === 0) return textResult("No matching memories found.", { count: 0 });
    const lines = result.items.map((item) => `- [${item.type}] (score: ${score(item.score)}) ${item.content}`);
    return textResult(lines.join("\n"), { count: result.items.length });
  } catch (error) {
    return textResult(`Memory search failed: ${safeErrorMessage(error)}`);
  }
}

export async function conversationSearch(
  memory: MemoryClient,
  params: ConversationSearchParams,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const query = params.query.trim();
  if (!query) return textResult("Query cannot be empty.");
  try {
    const result = await memory.searchConversation({
      query,
      ...(params.limit === undefined ? {} : { limit: params.limit }),
      ...(params.session_key === undefined ? {} : { session_id: params.session_key }),
    });
    if (result.messages.length === 0) return textResult("No matching conversation messages found.", { count: 0 });
    const lines = result.messages.map((message) => {
      const timestamp = message.timestamp ? ` [${message.timestamp}]` : "";
      return `- [${message.role}]${timestamp} ${message.content}`;
    });
    return textResult(lines.join("\n"), { count: result.messages.length });
  } catch (error) {
    return textResult(`Memory search failed: ${safeErrorMessage(error)}`);
  }
}
