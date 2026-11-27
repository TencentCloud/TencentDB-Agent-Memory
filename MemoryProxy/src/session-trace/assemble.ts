/**
 * Rebuild a streamed upstream reply into the body the same call would have
 * returned without streaming (cos-format.md, online call record `response`).
 *
 * Assemblers are fed the parsed SSE `data:` payloads by the handler's existing
 * tap loop, in order. Each one yields its protocol's non-stream shape: an
 * OpenAI `chat.completion`, an Anthropic `message`, or a Responses `response`.
 */

type Json = Record<string, unknown>;

export interface ResponseAssembler {
  push(event: Json): void;
  result(): Json;
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse every `data:` line of one SSE event block; `[DONE]` and malformed lines are skipped. */
export function parseSseData(block: string): Json[] {
  const events: Json[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // not JSON — ignore
    }
  }
  return events;
}

// ── OpenAI chat completions ──────────────────────────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * Chunk-level fields other than `object` / `choices` (id, created, model,
 * system_fingerprint, usage, …) are carried over, last non-null value wins.
 * Deltas are merged generically: string fields concatenate (content,
 * reasoning_content, reasoning, refusal, …) and array fields append, so
 * vendor reasoning fields keep the name the upstream used. `tool_calls` are
 * merged by index into structured calls.
 */
export class OpenAIChatAssembler implements ResponseAssembler {
  private readonly meta = new Map<string, unknown>();
  private readonly fields = new Map<string, string | unknown[]>();
  private readonly toolCalls = new Map<number, OpenAIToolCall>();
  private role = "assistant";
  private finishReason: string | null = null;

  push(event: Json): void {
    for (const [key, value] of Object.entries(event)) {
      if (key === "object" || key === "choices" || value === null || value === undefined) continue;
      this.meta.set(key, value);
    }
    if (!Array.isArray(event.choices)) return;
    for (const c of event.choices) {
      if (!isRecord(c) || (typeof c.index === "number" && c.index !== 0)) continue;
      if (typeof c.finish_reason === "string") this.finishReason = c.finish_reason;
      if (isRecord(c.delta)) this.mergeDelta(c.delta);
    }
  }

  private mergeDelta(delta: Json): void {
    for (const [key, value] of Object.entries(delta)) {
      if (key === "role") {
        if (typeof value === "string") this.role = value;
      } else if (key === "tool_calls") {
        if (Array.isArray(value)) value.forEach((tc) => this.mergeToolCall(tc));
      } else if (typeof value === "string") {
        const prev = this.fields.get(key);
        this.fields.set(key, (typeof prev === "string" ? prev : "") + value);
      } else if (Array.isArray(value)) {
        const prev = this.fields.get(key);
        this.fields.set(key, [...(Array.isArray(prev) ? prev : []), ...value]);
      }
    }
  }

  private mergeToolCall(tc: unknown): void {
    if (!isRecord(tc)) return;
    const index = typeof tc.index === "number" ? tc.index : 0;
    let acc = this.toolCalls.get(index);
    if (!acc) {
      acc = { id: "", type: "function", function: { name: "", arguments: "" } };
      this.toolCalls.set(index, acc);
    }
    if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
    if (typeof tc.type === "string" && tc.type) acc.type = tc.type;
    const fn = isRecord(tc.function) ? tc.function : undefined;
    if (typeof fn?.name === "string") acc.function.name += fn.name;
    if (typeof fn?.arguments === "string") acc.function.arguments += fn.arguments;
  }

  result(): Json {
    const message: Json = { role: this.role };
    for (const [key, value] of this.fields) message[key] = value;
    if (!("content" in message)) message.content = this.toolCalls.size > 0 ? null : "";
    if (this.toolCalls.size > 0) {
      message.tool_calls = [...this.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc);
    }
    const { usage, ...meta } = Object.fromEntries(this.meta);
    return {
      ...meta,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

// ── Anthropic messages ───────────────────────────────────────────────────────

/**
 * `message_start.message` is the base (id, model, role, input usage); content
 * blocks are rebuilt by index from `content_block_start` plus their deltas,
 * and `message_delta` supplies stop_reason / stop_sequence and the final
 * usage. Block types without deltas (redacted_thinking, server tool results)
 * are kept exactly as started.
 */
export class AnthropicMessageAssembler implements ResponseAssembler {
  private message: Json = { type: "message", role: "assistant" };
  private readonly blocks = new Map<number, Json>();
  private readonly partialJson = new Map<number, string>();
  private stopReason: unknown = null;
  private stopSequence: unknown = null;
  private usage: Json | undefined;

  push(event: Json): void {
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message)) {
          this.message = { ...event.message };
          if (isRecord(event.message.usage)) this.usage = { ...event.message.usage };
        }
        break;
      case "content_block_start":
        if (typeof event.index === "number" && isRecord(event.content_block)) {
          this.blocks.set(event.index, { ...event.content_block });
        }
        break;
      case "content_block_delta":
        if (typeof event.index === "number" && isRecord(event.delta)) this.applyDelta(event.index, event.delta);
        break;
      case "message_delta":
        if (isRecord(event.delta)) {
          if ("stop_reason" in event.delta) this.stopReason = event.delta.stop_reason;
          if ("stop_sequence" in event.delta) this.stopSequence = event.delta.stop_sequence;
        }
        if (isRecord(event.usage)) this.usage = { ...(this.usage ?? {}), ...event.usage };
        break;
    }
  }

  private applyDelta(index: number, delta: Json): void {
    const block = this.blocks.get(index);
    if (!block) return;
    const append = (field: string, value: unknown) => {
      if (typeof value !== "string") return;
      block[field] = (typeof block[field] === "string" ? block[field] : "") + value;
    };
    switch (delta.type) {
      case "text_delta":
        append("text", delta.text);
        break;
      case "thinking_delta":
        append("thinking", delta.thinking);
        break;
      case "signature_delta":
        append("signature", delta.signature);
        break;
      case "input_json_delta":
        if (typeof delta.partial_json === "string") {
          this.partialJson.set(index, (this.partialJson.get(index) ?? "") + delta.partial_json);
        }
        break;
      case "citations_delta":
        if (delta.citation !== undefined) {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
        }
        break;
    }
  }

  result(): Json {
    const content = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([index, block]) => {
      const raw = this.partialJson.get(index);
      if (raw === undefined || raw === "") return block;
      try {
        return { ...block, input: JSON.parse(raw) as unknown };
      } catch {
        return { ...block, input: raw };
      }
    });
    return {
      ...this.message,
      content,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
    };
  }
}

// ── OpenAI Responses ─────────────────────────────────────────────────────────

const RESPONSES_FINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

/**
 * The final `response.*` event carries the whole response object. Upstreams
 * that send it with an empty `output` get the `response.output_item.done`
 * items filled in.
 */
export class ResponsesAssembler implements ResponseAssembler {
  private readonly items = new Map<number, unknown>();
  private finalResponse: Json | null = null;

  push(event: Json): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.output_item.done") {
      const index = typeof event.output_index === "number" ? event.output_index : this.items.size;
      if (event.item !== undefined) this.items.set(index, event.item);
      return;
    }
    if (RESPONSES_FINAL_EVENTS.has(type) && isRecord(event.response)) this.finalResponse = event.response;
  }

  result(): Json {
    const response = this.finalResponse ?? {};
    if (Array.isArray(response.output) && response.output.length > 0) return response;
    const output = [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    return { ...response, output };
  }
}
