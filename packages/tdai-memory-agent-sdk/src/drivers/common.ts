import type { AgentSdkRunInput, AgentSdkRunResult, AgentSdkSession, AgentSdkStreamEvent } from "../types.js";

export async function* streamFromUnknownResult(result: unknown): AsyncIterable<AgentSdkStreamEvent> {
  const streamEvents = isRecord(result) ? result.events : undefined;
  if (isAsyncIterable(streamEvents)) {
    yield* streamFromEventIterable(streamEvents, result);
    return;
  }
  if (isIterable(streamEvents)) {
    yield* streamFromEventIterable(streamEvents, result);
    return;
  }

  if (isAsyncIterable(result)) {
    yield* streamFromEventIterable(result, result);
    return;
  }

  if (isIterable(result)) {
    yield* streamFromEventIterable(result, result);
    return;
  }

  const text = extractText(result);
  if (text) {
    yield { type: "agent.text.delta", text };
  }
  yield { type: "agent.completed", text, result };
}

async function* streamFromEventIterable(
  events: AsyncIterable<unknown> | Iterable<unknown>,
  result: unknown,
): AsyncIterable<AgentSdkStreamEvent> {
  let finalText = "";
  const seenAgentMessages = new Set<string>();
  for await (const event of events) {
    yield { type: "agent.event", event };
    const delta = extractTextDelta(event);
    if (delta) {
      finalText += delta;
      yield { type: "agent.text.delta", text: delta };
    }

    const messageText = extractCompletedMessageText(event);
    if (messageText && !seenAgentMessages.has(messageText)) {
      seenAgentMessages.add(messageText);
      finalText += messageText;
      yield { type: "agent.text.delta", text: messageText };
    }
  }
  const resultText = extractText(result);
  yield { type: "agent.completed", text: resultText || finalText, result };
}

export async function runFromStream(session: AgentSdkSession, input: AgentSdkRunInput): Promise<AgentSdkRunResult> {
  const events: AgentSdkStreamEvent[] = [];
  const chunks: string[] = [];
  let rawResult: unknown;
  for await (const event of session.stream(input)) {
    events.push(event);
    if (event.type === "agent.text.delta") chunks.push(event.text);
    if (event.type === "agent.completed") {
      rawResult = event.result;
      if (event.text) {
        chunks.length = 0;
        chunks.push(event.text);
      }
    }
  }
  return { text: chunks.join(""), rawResult, events };
}

export function extractTextDelta(event: unknown): string {
  if (typeof event === "string") return event;
  if (!isRecord(event)) return "";

  const direct = firstString(
    event.delta,
    event.text_delta,
    event.textDelta,
    event.content_delta,
    event.contentDelta,
  );
  if (direct) return direct;

  const type = typeof event.type === "string" ? event.type : "";
  if (type.includes("delta") || type.includes("content_block_delta")) {
    const nested = firstString(
      getPath(event, ["delta", "text"]),
      getPath(event, ["delta", "content"]),
      getPath(event, ["content", "text"]),
      getPath(event, ["message", "content"]),
      getPath(event, ["item", "text"]),
    );
    if (nested) return nested;
  }

  return "";
}

export function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return "";

  const direct = firstString(
    result.text,
    result.finalResponse,
    result.result,
    result.output_text,
    result.outputText,
    result.content,
    result.message,
  );
  if (direct) return direct;

  const content = result.content;
  if (Array.isArray(content)) {
    return content.map((item) => extractText(item)).filter(Boolean).join("");
  }

  const messageContent = getPath(result, ["message", "content"]);
  if (Array.isArray(messageContent)) {
    return messageContent.map((item) => extractText(item)).filter(Boolean).join("");
  }

  const resultContent = getPath(result, ["result", "content"]);
  if (Array.isArray(resultContent)) {
    return resultContent.map((item) => extractText(item)).filter(Boolean).join("");
  }

  const nested = firstString(
    getPath(result, ["delta", "text"]),
    getPath(result, ["content", "text"]),
    getPath(result, ["message", "text"]),
    getPath(result, ["result", "text"]),
    getPath(result, ["result", "finalResponse"]),
  );
  return nested ?? "";
}

function extractCompletedMessageText(event: unknown): string {
  if (!isRecord(event)) return "";
  if (event.type === "result" && typeof event.result === "string") {
    return event.result;
  }
  const item = event.item;
  if (isRecord(item) && item.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  const message = event.message;
  if (typeof message === "string") return message;
  if (isRecord(message)) return extractText(message);
  if (Array.isArray(message)) return message.map((part) => extractText(part)).filter(Boolean).join("");
  return "";
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

export function withAbortController<T>(options: T, signal?: AbortSignal): T {
  const base: Record<string, unknown> = isRecord(options) ? { ...options } : {};
  delete base.signal;
  if (!signal) return (isRecord(options) ? base : options) as T;

  const abortController = new AbortController();
  const abort = () => abortController.abort(signal.reason);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  return { ...base, abortController } as T;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.iterator in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function getPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
