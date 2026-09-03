/**
 * Anthropic Protocol Adapter.
 * Converts Anthropic Messages API format ↔ AgentContext.
 *
 * Anthropic message format:
 *   - Top-level "system" field (string or ContentBlock[])
 *   - messages[]: { role: "user"|"assistant", content: ContentBlock[] }
 *   - ContentBlock types: text, tool_use, tool_result, thinking, image
 */

import type { ProtocolAdapter } from "./interface.js";
import type {
  AgentContext,
  AgentContextMetadata,
  AgentTool,
  ContextBlock,
  ContextMessage,
} from "../types.js";

export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocol = "anthropic" as const;

  parse(body: Record<string, unknown>, metadata: AgentContextMetadata): AgentContext {
    const messages: ContextMessage[] = [];

    // Anthropic has a top-level "system" field
    if (body.system != null) {
      const systemBlocks = this.parseSystemField(body.system);
      messages.push({ role: "system", blocks: systemBlocks });
    }

    // Parse conversation messages
    const rawMessages = (body.messages as unknown[]) ?? [];
    for (const raw of rawMessages) {
      const m = raw as Record<string, unknown>;
      messages.push(this.parseMessage(m));
    }

    // Extract tools
    let tools: AgentTool[] | undefined;
    if (Array.isArray(body.tools)) {
      tools = (body.tools as Record<string, unknown>[]).map((t) => this.parseTool(t));
    }

    // Extract request parameters (everything except messages, system, tools)
    const requestParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "messages" && key !== "system" && key !== "tools") {
        requestParams[key] = value;
      }
    }

    return { messages, tools, requestParams, metadata };
  }

  serialize(ctx: AgentContext): Record<string, unknown> {
    const body: Record<string, unknown> = { ...ctx.requestParams };

    // Separate system message from conversation messages
    const systemMsg = ctx.messages.find((m) => m.role === "system");
    const conversationMsgs = ctx.messages.filter((m) => m.role !== "system");

    // Serialize system as top-level field
    if (systemMsg) {
      body.system = this.serializeSystemMessage(systemMsg);
    }

    // Serialize conversation messages
    body.messages = conversationMsgs.map((m) => this.serializeMessage(m));

    // Serialize tools
    if (ctx.tools && ctx.tools.length > 0) {
      body.tools = ctx.tools.map((t) => this.serializeTool(t));
    }

    return body;
  }

  // ── Private: parse helpers ──────────────────────────────────────────────────

  private parseSystemField(system: unknown): ContextBlock[] {
    if (typeof system === "string") {
      return [{ type: "text", content: system }];
    }
    if (Array.isArray(system)) {
      return (system as Record<string, unknown>[]).map((block) => this.parseContentBlock(block));
    }
    return [{ type: "text", content: String(system) }];
  }

  private parseMessage(m: Record<string, unknown>): ContextMessage {
    const role = m.role as "user" | "assistant";
    const content = m.content;
    const blocks: ContextBlock[] = [];

    if (typeof content === "string") {
      blocks.push({ type: "text", content });
    } else if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        blocks.push(this.parseContentBlock(block));
      }
    }

    return { role, blocks };
  }

  private parseContentBlock(block: Record<string, unknown>): ContextBlock {
    const type = block.type as string;
    const parsed = this.parseContentBlockInner(block, type);
    // Preserve prompt-cache breakpoint marker across the round-trip.
    if (block.cache_control !== undefined && parsed.type !== "custom") {
      parsed.metadata = { ...parsed.metadata, cache_control: block.cache_control };
    }
    return parsed;
  }

  private parseContentBlockInner(block: Record<string, unknown>, type: string): ContextBlock {
    switch (type) {
      case "text":
        return { type: "text", content: block.text as string };

      case "tool_use":
        return {
          type: "tool_use",
          content: JSON.stringify({
            name: block.name as string,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          }),
          metadata: { tool_id: block.id as string },
        };

      case "tool_result": {
        const resultContent = block.content;
        let contentStr: string;
        if (typeof resultContent === "string") {
          contentStr = resultContent;
        } else if (Array.isArray(resultContent)) {
          // tool_result can have nested content blocks
          contentStr = (resultContent as Record<string, unknown>[])
            .filter((c) => c.type === "text")
            .map((c) => c.text as string)
            .join("\n");
        } else {
          contentStr = JSON.stringify(resultContent ?? "");
        }
        return {
          type: "tool_result",
          content: contentStr,
          metadata: {
            tool_use_id: block.tool_use_id as string,
            is_error: block.is_error as boolean | undefined,
          },
        };
      }

      case "thinking":
        return {
          type: "thinking",
          content: (block.thinking as string) ?? "",
          metadata: { signature: block.signature },
        };

      case "image": {
        const source = block.source as Record<string, unknown> | undefined;
        return {
          type: "image",
          content: (source?.data as string) ?? "",
          metadata: {
            media_type: source?.media_type,
            source_type: source?.type,
          },
        };
      }

      default:
        return {
          type: "custom",
          content: JSON.stringify(block),
          metadata: { original_type: type },
        };
    }
  }

  private parseTool(raw: Record<string, unknown>): AgentTool {
    const { name, description, input_schema, cache_control, ...rest } = raw;
    const tool: AgentTool = {
      name: (name as string) ?? "unknown",
      description: (description as string) ?? "",
      parameters: (input_schema as Record<string, unknown>) ?? {},
    };

    if (cache_control !== undefined) {
      tool.cacheControl = cache_control;
    }
    
    if (Object.keys(rest).length > 0) {
      tool.custom = rest;
    }
    
    return tool;
  }

  // ── Private: serialize helpers ──────────────────────────────────────────────

  private serializeSystemMessage(msg: ContextMessage): unknown {
    const textBlocks = msg.blocks.filter((b) => b.type === "text");
    if (textBlocks.length === 1) {
      return textBlocks[0].content;
    }
    // Multiple blocks → use array format
    return msg.blocks.map((b) => this.serializeContentBlock(b));
  }

  private serializeMessage(msg: ContextMessage): Record<string, unknown> {
    const content = msg.blocks.map((b) => this.serializeContentBlock(b));
    return { role: msg.role, content };
  }

  private serializeContentBlock(block: ContextBlock): Record<string, unknown> {
    const out = this.serializeContentBlockInner(block);
    // Restore prompt-cache breakpoint marker (skip custom: already fully rebuilt from JSON).
    if (block.type !== "custom" && block.metadata?.cache_control !== undefined) {
      out.cache_control = block.metadata.cache_control;
    }
    return out;
  }

  private serializeContentBlockInner(block: ContextBlock): Record<string, unknown> {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.content };

      case "tool_use": {
        const parsed = JSON.parse(block.content) as { name: string; arguments: string };
        const input = typeof parsed.arguments === "string"
          ? JSON.parse(parsed.arguments)
          : parsed.arguments;
        return {
          type: "tool_use",
          id: block.metadata?.tool_id ?? "",
          name: parsed.name,
          input,
        };
      }

      case "tool_result": {
        const result: Record<string, unknown> = {
          type: "tool_result",
          tool_use_id: block.metadata?.tool_use_id ?? "",
          content: block.content,
        };
        if (block.metadata?.is_error) {
          result.is_error = true;
        }
        return result;
      }

      case "thinking":
        return {
          type: "thinking",
          thinking: block.content,
          signature: block.metadata?.signature ?? "",
        };

      case "image":
        return {
          type: "image",
          source: {
            type: block.metadata?.source_type ?? "base64",
            media_type: block.metadata?.media_type ?? "image/png",
            data: block.content,
          },
        };

      default:
        // Custom/unknown → try to reconstruct from content
        try {
          return JSON.parse(block.content) as Record<string, unknown>;
        } catch {
          return { type: block.type, content: block.content };
        }
    }
  }

  private serializeTool(tool: AgentTool): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    };
    
    if (tool.cacheControl !== undefined) {
      out.cache_control = tool.cacheControl;
    }
    
    if (tool.custom) {
      Object.assign(out, tool.custom);
      // Remove hallucinated fields for Anthropic server tools (which define a custom 'type')
      if (typeof tool.custom.type === "string") {
        delete out.description;
        delete out.input_schema;
      }
    }
    
    return out;
  }
}
