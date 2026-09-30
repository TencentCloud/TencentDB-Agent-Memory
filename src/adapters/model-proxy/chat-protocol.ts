import type {
  ChatCompletionRequest,
  ChatMessage,
  RecallResponseCompat,
} from "./types.js";

const MEMORY_START = "<tdai-memory>";
const MEMORY_END = "</tdai-memory>";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseChatCompletionRequest(value: unknown): ChatCompletionRequest {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Request must contain a messages array");
  }
  for (const message of value.messages) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new Error("Every message must contain a string role");
    }
  }
  return value as unknown as ChatCompletionRequest;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return stripInjectedMemory(content).trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
        return stripInjectedMemory(part.text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function findLastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

export function getLastUserText(messages: ChatMessage[]): string {
  const index = findLastUserIndex(messages);
  return index >= 0 ? extractText(messages[index].content) : "";
}

export function selectRecallContext(
  response: RecallResponseCompat,
  maxChars: number,
): string {
  const parts = [
    response.append_system_context,
    response.prepend_context,
    response.context,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  const unique = [...new Set(parts)];
  return unique.join("\n\n").slice(0, Math.max(0, maxChars));
}

/**
 * Inject memory into the last user message of a cloned request. Keeping the
 * block near the tail avoids invalidating the stable system-prefix cache.
 */
export function injectRecallContext(
  request: ChatCompletionRequest,
  context: string,
): ChatCompletionRequest {
  if (!context) return request;
  const index = findLastUserIndex(request.messages);
  if (index < 0) return request;

  const messages = request.messages.map((message) => ({ ...message }));
  const target = messages[index];
  const block = `${MEMORY_START}\n${context}\n${MEMORY_END}`;

  if (typeof target.content === "string") {
    target.content = `${stripInjectedMemory(target.content).trimEnd()}\n\n${block}`;
  } else if (Array.isArray(target.content)) {
    target.content = [
      ...target.content,
      { type: "text", text: block },
    ];
  } else {
    target.content = block;
  }

  return { ...request, messages };
}

export function canonicalizeMessage(message: ChatMessage): string {
  const canonical: Record<string, unknown> = {
    role: message.role,
    content: extractText(message.content),
  };
  if (message.name) canonical.name = message.name;
  if (message.tool_call_id) canonical.tool_call_id = message.tool_call_id;
  if (message.tool_calls !== undefined) {
    canonical.tool_calls = normalizeJson(message.tool_calls);
  }
  return JSON.stringify(canonical);
}

export function stripInjectedMemory(text: string): string {
  let result = text;
  for (;;) {
    const start = result.indexOf(MEMORY_START);
    if (start < 0) break;
    const end = result.indexOf(MEMORY_END, start + MEMORY_START.length);
    if (end < 0) {
      result = result.slice(0, start);
      break;
    }
    result = result.slice(0, start) + result.slice(end + MEMORY_END.length);
  }
  return result;
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalizeJson(child)]),
  );
}
