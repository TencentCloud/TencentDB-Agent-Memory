import type { ChatMessage } from "./types.js";
import { extractText } from "./chat-protocol.js";

interface ToolCallAccumulator {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collects one assistant message from either a regular Chat Completions body
 * or its SSE delta stream while leaving the bytes sent to the client untouched.
 */
export class CompletionAccumulator {
  private content = "";
  private role = "assistant";
  private finishReason?: string;
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();

  acceptResponseBody(value: unknown): void {
    if (!isRecord(value) || !Array.isArray(value.choices)) return;
    const choice = value.choices[0];
    if (!isRecord(choice)) return;
    if (typeof choice.finish_reason === "string") {
      this.finishReason = choice.finish_reason;
    }
    if (isRecord(choice.message)) {
      const message = choice.message;
      if (typeof message.role === "string") this.role = message.role;
      this.content += extractText(message.content);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) this.acceptToolCall(call);
      }
    }
  }

  acceptStreamData(data: string): void {
    if (data.trim() === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(value) || !Array.isArray(value.choices)) return;
    const choice = value.choices[0];
    if (!isRecord(choice)) return;
    if (typeof choice.finish_reason === "string") {
      this.finishReason = choice.finish_reason;
    }
    if (!isRecord(choice.delta)) return;
    const delta = choice.delta;
    if (typeof delta.role === "string") this.role = delta.role;
    if (typeof delta.content === "string") this.content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) this.acceptToolCall(call);
    }
  }

  assistantMessage(): ChatMessage {
    const message: ChatMessage = {
      role: this.role,
      content: this.content,
    };
    if (this.toolCalls.size > 0) {
      message.tool_calls = [...this.toolCalls.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ index: _index, ...call }) => call);
    }
    return message;
  }

  assistantText(): string {
    return this.content.trim();
  }

  shouldCapture(): boolean {
    return this.assistantText().length > 0 &&
      this.finishReason !== "tool_calls" &&
      this.finishReason !== "function_call";
  }

  private acceptToolCall(value: unknown): void {
    if (!isRecord(value)) return;
    const index = typeof value.index === "number" ? value.index : this.toolCalls.size;
    const existing = this.toolCalls.get(index) ?? {
      index,
      function: { arguments: "" },
    };
    if (typeof value.id === "string") existing.id = value.id;
    if (typeof value.type === "string") existing.type = value.type;
    if (isRecord(value.function)) {
      existing.function ??= { arguments: "" };
      if (typeof value.function.name === "string") {
        existing.function.name = value.function.name;
      }
      if (typeof value.function.arguments === "string") {
        existing.function.arguments += value.function.arguments;
      }
    }
    this.toolCalls.set(index, existing);
  }
}

export class SseDataParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private dataLines: string[] = [];

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.consumeLines(false);
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.consumeLines(true);
    this.emitEvent();
  }

  private consumeLines(flush: boolean): void {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.acceptLine(line);
    }
    if (flush && this.buffer) {
      this.acceptLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
    }
  }

  private acceptLine(line: string): void {
    if (line === "") {
      this.emitEvent();
      return;
    }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  private emitEvent(): void {
    if (this.dataLines.length === 0) return;
    this.onData(this.dataLines.join("\n"));
    this.dataLines = [];
  }
}
