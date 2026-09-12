/** Shared wire-level helpers. Archival/injection formats are intentionally separate. */
export type WireProtocol = "chat" | "anthropic" | "responses";
export type JsonObject = Record<string, unknown>;
export interface ConversionOptions {
  /** Required fallback for a target Messages request when the source omits its limit. */
  maxTokens?: number;
  /** Providing this callback explicitly acknowledges nonportable cache controls. */
  onWarning?: (message: string) => void;
}

export class ProtocolError extends Error {
  constructor(message: string, readonly param?: string, readonly status = 400) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function object(value: unknown, param = "body"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`Expected an object at ${param}`, param);
  }
  return value as JsonObject;
}

export function list(value: unknown, param: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`Expected an array at ${param}`, param);
  return value;
}

export function string(value: unknown, param: string): string {
  if (typeof value !== "string") throw new ProtocolError(`Expected text at ${param}`, param);
  return value;
}

export function unsupported(param: string): never {
  throw new ProtocolError(`Cannot preserve ${param} in the target protocol`, param);
}

export function checkFields(body: JsonObject, allowed: string[], param = "body") {
  for (const [key, value] of Object.entries(body)) {
    if (value != null && !allowed.includes(key)) unsupported(`${param}.${key}`);
  }
}

export function acknowledgeCache(block: JsonObject, options: ConversionOptions) {
  if (block.cache_control == null) return;
  if (!options.onWarning) unsupported("cache_control");
  options.onWarning("cache_control has no portable equivalent; upstream cache policy applies");
}

export function outputLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolError("A positive max_tokens limit or configured maxTokens fallback is required", "max_tokens");
  }
  return value;
}

export function parseArguments(value: unknown, param = "arguments"): JsonObject {
  try { return object(JSON.parse(string(value, param)), param); }
  catch { throw new ProtocolError(`Invalid JSON object in ${param}`, param); }
}

function counter(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`Invalid upstream usage counter: ${name}`, "usage", 502);
  }
  return value;
}

/** Counts remain measurements from the upstream tokenizer, not a retokenization. */
export function convertUsage(raw: unknown, from: WireProtocol, to: WireProtocol): JsonObject | undefined {
  if (raw == null) return undefined;
  const usage = object(raw, "usage");
  if (from === to) return { ...usage };
  const inputKey = from === "chat" ? "prompt_tokens" : "input_tokens";
  const outputKey = from === "chat" ? "completion_tokens" : "output_tokens";
  const input = counter(usage[inputKey], inputKey);
  const output = counter(usage[outputKey], outputKey);
  const details = usage[from === "chat" ? "prompt_tokens_details" : "input_tokens_details"];
  const read = counter(from === "anthropic"
    ? usage.cache_read_input_tokens
    : details == null ? undefined : object(details, "usage.details").cached_tokens, "cached_tokens");
  const created = from === "anthropic" ? counter(usage.cache_creation_input_tokens, "cache_creation_input_tokens") : undefined;
  if (from !== "anthropic" && input !== undefined && read !== undefined && read > input) {
    throw new ProtocolError("Upstream cached tokens exceed total input tokens", "usage", 502);
  }
  const totalInput = input === undefined ? undefined : from === "anthropic" ? input + (read ?? 0) + (created ?? 0) : input;
  const result: JsonObject = {};
  if (to === "anthropic") {
    if (totalInput !== undefined) result.input_tokens = totalInput - (read ?? 0);
    if (output !== undefined) result.output_tokens = output;
    if (read !== undefined) result.cache_read_input_tokens = read;
    // OpenAI does not report Anthropic cache-write TTL categories. Do not invent them.
  } else {
    if (totalInput !== undefined) result[to === "chat" ? "prompt_tokens" : "input_tokens"] = totalInput;
    if (output !== undefined) result[to === "chat" ? "completion_tokens" : "output_tokens"] = output;
    if (totalInput !== undefined && output !== undefined) result.total_tokens = totalInput + output;
    if (read !== undefined) result[to === "chat" ? "prompt_tokens_details" : "input_tokens_details"] = { cached_tokens: read };
    if (from !== "anthropic") {
      const outputDetails = usage[from === "chat" ? "completion_tokens_details" : "output_tokens_details"];
      if (outputDetails !== undefined) result[to === "chat" ? "completion_tokens_details" : "output_tokens_details"] = { ...object(outputDetails, "usage.output_details") };
    }
  }
  return result;
}

export interface SseFrame { event: string; data: string; id?: string }

/** Incremental SSE framing; decoding alone never establishes model completion. */
export function createSseDecoder(maxFrameChars = 2 * 1024 * 1024): TransformStream<Uint8Array, SseFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  let frameChars = 0;
  const limit = () => { if (frameChars + buffer.length > maxFrameChars) throw new ProtocolError("Upstream SSE frame exceeds limit", undefined, 502); };
  function line(value: string, controller: TransformStreamDefaultController<SseFrame>) {
    if (!value) {
      if (data.length) controller.enqueue({ event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
      event = "message"; data = []; frameChars = 0;
      return;
    }
    frameChars += value.length + 1;
    if (frameChars > maxFrameChars) throw new ProtocolError("Upstream SSE frame exceeds limit", undefined, 502);
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
    else if (field === "event") event = content || "message";
    else if (field === "id" && !content.includes("\0")) id = content;
  }
  function drain(controller: TransformStreamDefaultController<SseFrame>, eof = false) {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== "\n" && buffer[i] !== "\r") continue;
      if (buffer[i] === "\r" && i + 1 === buffer.length && !eof) break;
      line(buffer.slice(start, i), controller);
      if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    limit();
  }
  return new TransformStream({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); drain(controller); },
    flush(controller) {
      buffer += decoder.decode(); drain(controller, true);
      if (data.length || (buffer && !buffer.startsWith(":"))) {
        throw new ProtocolError("Truncated upstream SSE frame", undefined, 502);
      }
    },
  });
}

export function sseFrame(event: string | undefined, data: unknown): Uint8Array {
  return new TextEncoder().encode(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}
