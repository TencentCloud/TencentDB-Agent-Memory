/**
 * Rebuild the full model reply of one upstream call, streamed or not.
 *
 * Streaming assemblers are fed the parsed SSE `data:` payloads by the
 * handler's existing tap loop, in order. The reply keeps each protocol's own
 * shape (cos-format.md §3.4): an OpenAI chat `message`, an Anthropic
 * `{ role, content }`, or `{ output: [...] }` for Responses.
 */

export interface ModelReply {
  /** The `output` object of the turn record. */
  output: Record<string, unknown>;
  /** finish_reason / stop_reason / Responses status; null when the upstream never sent one. */
  stopReason: string | null;
  /** Client-executed tool calls the reply asks for. */
  toolCallCount: number;
}

type Json = Record<string, unknown>;

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

export function openaiReplyFromJson(json: unknown): ModelReply | null {
  if (!isRecord(json) || !Array.isArray(json.choices)) return null;
  const choice = json.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const message = choice.message;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
  return {
    output: message,
    stopReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    toolCallCount: toolCalls + (isRecord(message.function_call) ? 1 : 0),
  };
}

interface OpenAIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * Deltas are merged generically: string fields concatenate (content,
 * reasoning_content, reasoning, refusal, …) and array fields append, so
 * vendor reasoning fields keep the name the upstream used. `tool_calls` are
 * merged by index into structured calls.
 */
export class OpenAIChatAssembler {
  private readonly fields = new Map<string, string | unknown[]>();
  private readonly toolCalls = new Map<number, OpenAIToolCall>();
  private role = "assistant";
  private finishReason: string | null = null;

  push(event: Json): void {
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

  result(): ModelReply {
    const output: Json = { role: this.role };
    for (const [key, value] of this.fields) output[key] = value;
    if (!("content" in output)) output.content = this.toolCalls.size > 0 ? null : "";
    if (this.toolCalls.size > 0) {
      output.tool_calls = [...this.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc);
    }
    return { output, stopReason: this.finishReason, toolCallCount: this.toolCalls.size };
  }
}

// ── Anthropic messages ───────────────────────────────────────────────────────

function countToolUse(content: unknown[]): number {
  return content.filter((b) => isRecord(b) && b.type === "tool_use").length;
}

export function anthropicReplyFromJson(json: unknown): ModelReply | null {
  if (!isRecord(json) || !Array.isArray(json.content)) return null;
  return {
    output: { role: typeof json.role === "string" ? json.role : "assistant", content: json.content },
    stopReason: typeof json.stop_reason === "string" ? json.stop_reason : null,
    toolCallCount: countToolUse(json.content),
  };
}

/**
 * Content blocks are rebuilt by index from `content_block_start` plus their
 * deltas. Block types without deltas (redacted_thinking, server tool results)
 * are kept exactly as started.
 */
export class AnthropicMessageAssembler {
  private readonly blocks = new Map<number, Json>();
  private readonly partialJson = new Map<number, string>();
  private role = "assistant";
  private stopReason: string | null = null;

  push(event: Json): void {
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message) && typeof event.message.role === "string") this.role = event.message.role;
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
        if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") {
          this.stopReason = event.delta.stop_reason;
        }
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

  result(): ModelReply {
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
      output: { role: this.role, content },
      stopReason: this.stopReason,
      toolCallCount: countToolUse(content),
    };
  }
}

// ── OpenAI Responses ─────────────────────────────────────────────────────────

const RESPONSES_CLIENT_TOOL_ITEMS = new Set(["function_call", "custom_tool_call", "local_shell_call", "computer_call"]);

function countResponsesToolCalls(output: unknown[]): number {
  return output.filter((item) => isRecord(item) && typeof item.type === "string" && RESPONSES_CLIENT_TOOL_ITEMS.has(item.type)).length;
}

export function responsesReplyFromJson(json: unknown): ModelReply | null {
  if (!isRecord(json) || !Array.isArray(json.output)) return null;
  return {
    output: { output: json.output },
    stopReason: typeof json.status === "string" ? json.status : "completed",
    toolCallCount: countResponsesToolCalls(json.output),
  };
}

const RESPONSES_FINAL_EVENTS: Record<string, string> = {
  "response.completed": "completed",
  "response.incomplete": "incomplete",
  "response.failed": "failed",
};

/**
 * The final `response.*` event normally carries the whole `output` array;
 * `response.output_item.done` items are collected as a fallback for upstreams
 * that send an empty one.
 */
export class ResponsesAssembler {
  private readonly items = new Map<number, unknown>();
  private finalOutput: unknown[] | null = null;
  private status: string | null = null;

  push(event: Json): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.output_item.done") {
      const index = typeof event.output_index === "number" ? event.output_index : this.items.size;
      if (event.item !== undefined) this.items.set(index, event.item);
      return;
    }
    const finalStatus = RESPONSES_FINAL_EVENTS[type];
    if (!finalStatus) return;
    const resp = isRecord(event.response) ? event.response : {};
    this.status = typeof resp.status === "string" ? resp.status : finalStatus;
    if (Array.isArray(resp.output)) this.finalOutput = resp.output;
  }

  result(): ModelReply {
    const output = this.finalOutput && this.finalOutput.length > 0
      ? this.finalOutput
      : [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    return {
      output: { output },
      stopReason: this.status,
      toolCallCount: countResponsesToolCalls(output),
    };
  }
}
