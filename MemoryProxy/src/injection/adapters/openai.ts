/**
 * OpenAI Protocol Adapter.
 * Converts OpenAI Chat Completions format ↔ AgentContext.
 *
 * OpenAI message format:
 *   - system/user: { role, content: string | ContentPart[] }
 *   - assistant: { role, content: string | null, tool_calls?: ToolCall[] }
 *   - tool: { role: "tool", content: string, tool_call_id: string }
 */

import type { ProtocolAdapter } from "./interface.js";
import type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  ContextBlock,
  ContextMessage,
  MessageRole,
} from "../types.js";

export class OpenAIAdapter implements ProtocolAdapter {
  readonly protocol = "openai" as const;

  parse(body: Record<string, unknown>, metadata: AgentContextMetadata): AgentContext {
    const rawMessages = (body.messages as unknown[]) ?? [];
    const messages: ContextMessage[] = rawMessages.map((m) => this.parseMessage(m));

    // Extract tools if present
    let tools: AgentTool[] | undefined;
    if (Array.isArray(body.tools)) {
      tools = (body.tools as Record<string, unknown>[]).map((t) => this.parseTool(t));
    }

    // Extract request parameters (everything except messages and tools)
    const requestParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "messages" && key !== "tools") {
        requestParams[key] = value;
      }
    }

    return { messages, tools, requestParams, metadata };
  }

  serialize(ctx: AgentContext): Record<string, unknown> {
    const messages = ctx.messages.map((m) => this.serializeMessage(m));

    const body: Record<string, unknown> = {
      ...ctx.requestParams,
      messages,
    };

    // Add tools if present
    if (ctx.tools) {
      body.tools = ctx.tools.map((t) => this.serializeTool(t));
    }

    return body;
  }

  // ── Private: parse helpers ──────────────────────────────────────────────────

  private parseMessage(raw: unknown): ContextMessage {
    const result = this.parseMessageInner(raw);
    result.native = structuredClone(raw as Record<string, unknown>);
    return result;
  }

  private parseMessageInner(raw: unknown): ContextMessage {
    const m = raw as Record<string, unknown>;
    const role = m.role as MessageRole;
    const blocks: ContextBlock[] = [];

    if (role === "tool") {
      // Tool role: { role: "tool", content: string, tool_call_id: string }
      blocks.push({
        type: "tool_result",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        metadata: { tool_use_id: m.tool_call_id as string },
      });
      return { role, blocks };
    }

    if (role === "assistant") {
      // Assistant message: may have content + tool_calls
      const content = m.content;
      if (typeof content === "string" && content.length > 0) {
        blocks.push({ type: "text", content });
      } else if (Array.isArray(content)) {
        // Array content parts (rare for assistant, but possible)
        for (const part of content as Record<string, unknown>[]) {
          blocks.push(this.parseContentPart(part));
        }
      }

      // OpenAI tool_calls at top level
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Record<string, unknown>[]) {
          const fn = tc.function as Record<string, unknown> | undefined;
          blocks.push({
            type: "tool_use",
            content: JSON.stringify({
              name: fn?.name ?? "unknown",
              arguments: fn?.arguments ?? "{}",
            }),
            metadata: { tool_id: tc.id as string }, native: structuredClone(tc),
          });
        }
      }

      // Preserve `reasoning_content` (deepseek thinking-mode; dsh 客户端必带此字段
      // 回传上游,否则 deepseek 官方 400 `reasoning_content ... must be passed back`).
      // 其它 OpenAI 兼容上游不认识这个字段,pass-through 无害。
      const msg: ContextMessage = { role, blocks };
      if (typeof m.reasoning_content === "string") {
        msg.metadata = { ...(msg.metadata ?? {}), reasoning_content: m.reasoning_content };
      }
      return msg;
    }

    // system or user
    const content = m.content;
    if (typeof content === "string") {
      blocks.push({ type: "text", content });
    } else if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        blocks.push(this.parseContentPart(part));
      }
    }

    return { role, blocks };
  }

  private parseContentPart(part: Record<string, unknown>): ContextBlock {
    const result = this.parseContentPartInner(part);
    result.native = structuredClone(part);
    return result;
  }

  private parseContentPartInner(part: Record<string, unknown>): ContextBlock {
    const type = part.type as string;
    switch (type) {
      case "text":
        return { type: "text", content: part.text as string };
      case "image_url": {
        const imageUrl = part.image_url as Record<string, unknown> | undefined;
        return {
          type: "image",
          content: (imageUrl?.url as string) ?? "",
          metadata: { detail: imageUrl?.detail },
        };
      }
      default:
        return {
          type: "custom",
          content: JSON.stringify(part),
          metadata: { original_type: type },
        };
    }
  }

  private parseTool(raw: Record<string, unknown>): AgentTool {
    const fn = raw.function as Record<string, unknown> | undefined;
    return {
      name: (fn?.name as string) ?? (raw.name as string) ?? "unknown",
      description: (fn?.description as string) ?? (raw.description as string) ?? "",
      parameters: (fn?.parameters as Record<string, unknown>) ?? (raw.parameters as Record<string, unknown>) ?? {},
      native: structuredClone(raw),
    };
  }

  // ── Private: serialize helpers ──────────────────────────────────────────────

  private serializeMessage(msg: ContextMessage): Record<string, unknown> {
    const result = this.serializeMessageInner(msg);
    const native = { ...msg.native };
    delete native.content;
    delete native.tool_calls;
    return { ...native, ...result };
  }

  private serializeMessageInner(msg: ContextMessage): Record<string, unknown> {
    if (msg.role === "tool") {
      // Serialize tool role message
      const toolResult = msg.blocks.find((b) => b.type === "tool_result");
      return {
        role: "tool",
        content: toolResult?.content ?? "",
        tool_call_id: toolResult?.metadata?.tool_use_id ?? "",
      };
    }

    if (msg.role === "assistant") {
      // Assistant can have text + tool_calls
      const contentBlocks = msg.blocks.filter((b) => b.type !== "tool_use");
      const toolUseBlocks = msg.blocks.filter((b) => b.type === "tool_use");

      const result: Record<string, unknown> = { role: "assistant" };

      // Content
      if (Array.isArray(msg.native?.content) || contentBlocks.some(b => b.type !== "text")) {
        result.content = contentBlocks.map(b => this.serializeContentPart(b));
      } else if (contentBlocks.length > 0) {
        result.content = contentBlocks.map((b) => b.content).join("");
      } else {
        result.content = null;
      }

      // Tool calls
      if (toolUseBlocks.length > 0) {
        result.tool_calls = toolUseBlocks.map((b) => {
          const parsed = JSON.parse(b.content) as { name: string; arguments: string };
          return {
            ...b.native,
            id: b.metadata?.tool_id ?? "",
            type: "function",
            function: {
              ...(b.native?.function as Record<string, unknown>),
              name: parsed.name,
              arguments: typeof parsed.arguments === "string"
                ? parsed.arguments
                : JSON.stringify(parsed.arguments),
            },
          };
        });
      }

      // Restore reasoning_content preserved during parse (deepseek thinking mode).
      const rc = msg.metadata?.reasoning_content;
      if (typeof rc === "string") {
        result.reasoning_content = rc;
      }

      return result;
    }

    // system or user
    const textBlocks = msg.blocks.filter((b) => b.type === "text");
    const otherBlocks = msg.blocks.filter((b) => b.type !== "text");

    if (otherBlocks.length === 0 && !Array.isArray(msg.native?.content) && !textBlocks.some(b => b.native)) {
      // Simple text-only message
      return {
        role: msg.role,
        content: textBlocks.map((b) => b.content).join("\n"),
      };
    }

    // Mixed content: serialize as array
    const parts = msg.blocks.map(block => this.serializeContentPart(block));

    return { role: msg.role, content: parts };
  }

  private serializeContentPart(block: ContextBlock): Record<string, unknown> {
    if (block.type === "text") return { ...block.native, type: "text", text: block.content };
    if (block.type === "image") return {
      ...block.native, type: "image_url",
      image_url: { ...(block.native?.image_url as Record<string, unknown>), url: block.content, ...(block.metadata?.detail !== undefined ? { detail: block.metadata.detail } : {}) },
    };
    if (block.type === "custom") return JSON.parse(block.content) as Record<string, unknown>;
    throw new Error(`Unsupported OpenAI injection content block: ${block.type}`);
  }

  private serializeTool(tool: AgentTool): Record<string, unknown> {
    if (tool.native && tool.native.type !== "function") return { ...tool.native };
    const nativeFunction = tool.native?.function as Record<string, unknown> | undefined;
    return {
      ...tool.native,
      type: "function",
      function: {
        ...nativeFunction,
        name: tool.name,
        ...(!nativeFunction || "description" in nativeFunction || tool.description !== "" ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    };
  }
}
