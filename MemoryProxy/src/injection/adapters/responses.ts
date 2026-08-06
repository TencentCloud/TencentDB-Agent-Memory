/**
 * OpenAI Responses protocol adapter.
 *
 * Codex sends conversation items through `input`. Treating that body as a
 * Chat Completions request silently writes injected context to `messages`, a
 * field the Responses API does not consume. This adapter keeps the native
 * input item sequence intact and only rewrites message text where hooks add
 * context.
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

type JsonRecord = Record<string, unknown>;

interface MessageTemplate {
  kind: "message";
  messageId: string;
  original: JsonRecord;
  originalRole: string;
  contentWasString: boolean;
  textType: string;
}

interface OpaqueTemplate {
  kind: "opaque";
  item: unknown;
}

interface ResponsesState {
  inputTemplate: Array<MessageTemplate | OpaqueTemplate>;
  toolTemplate: Array<{ kind: "function" } | { kind: "opaque"; tool: unknown }>;
}

const STATE_KEY = "__tdaiResponsesAdapterState";

export class ResponsesAdapter implements ProtocolAdapter {
  readonly protocol = "responses" as const;

  parse(body: JsonRecord, metadata: AgentContextMetadata): AgentContext {
    const input = normalizeInput(body.input);
    const inputTemplate: Array<MessageTemplate | OpaqueTemplate> = [];
    const messages: ContextMessage[] = [];

    for (const item of input) {
      const record = asRecord(item);
      const role = typeof record?.role === "string" ? record.role : "";
      if (!record || !isMessageRole(role)) {
        inputTemplate.push({ kind: "opaque", item });
        continue;
      }

      const messageId = `msg-${messages.length}`;
      const content = record.content;
      const parsed = parseContent(content);
      const normalizedRole: MessageRole = role === "developer" ? "system" : role as MessageRole;
      messages.push({
        role: normalizedRole,
        blocks: parsed.blocks,
        metadata: { messageId },
      });
      inputTemplate.push({
        kind: "message",
        messageId,
        original: record,
        originalRole: role,
        contentWasString: typeof content === "string",
        textType: parsed.textType,
      });
    }

    const { tools, toolTemplate } = parseTools(body.tools);
    const requestParams: JsonRecord = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== "input" && key !== "tools") requestParams[key] = value;
    }
    requestParams[STATE_KEY] = { inputTemplate, toolTemplate } satisfies ResponsesState;

    return { messages, tools, requestParams, metadata };
  }

  serialize(ctx: AgentContext): JsonRecord {
    const { [STATE_KEY]: rawState, ...requestParams } = ctx.requestParams;
    const state = rawState as ResponsesState | undefined;
    if (!state) {
      throw new Error("ResponsesAdapter state is missing");
    }

    const messagesById = new Map<string, ContextMessage>();
    for (const message of ctx.messages) {
      const messageId = typeof message.metadata?.messageId === "string"
        ? message.metadata.messageId
        : undefined;
      if (messageId) messagesById.set(messageId, message);
    }

    const input = state.inputTemplate.map((entry) => {
      if (entry.kind === "opaque") return entry.item;
      const message = messagesById.get(entry.messageId);
      if (!message) return entry.original;
      return serializeMessage(message, entry);
    });

    return {
      ...requestParams,
      input,
      ...(ctx.tools ? { tools: serializeTools(ctx.tools, state.toolTemplate) } : {}),
    };
  }
}

function normalizeInput(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return [];
}

function isMessageRole(role: string): role is "system" | "developer" | "user" | "assistant" {
  return role === "system" || role === "developer" || role === "user" || role === "assistant";
}

function parseContent(content: unknown): { blocks: ContextBlock[]; textType: string } {
  if (typeof content === "string") {
    return { blocks: [{ type: "text", content }], textType: "input_text" };
  }
  if (!Array.isArray(content)) return { blocks: [], textType: "input_text" };

  const blocks: ContextBlock[] = [];
  let textType = "input_text";
  for (const part of content) {
    const record = asRecord(part);
    const type = typeof record?.type === "string" ? record.type : "";
    const text = typeof record?.text === "string" ? record.text : undefined;
    if (text !== undefined && (type === "input_text" || type === "output_text" || type === "text")) {
      textType = type;
      blocks.push({ type: "text", content: text });
      continue;
    }
    blocks.push({ type: "custom", content: JSON.stringify(part) });
  }
  return { blocks, textType };
}

function serializeMessage(message: ContextMessage, template: MessageTemplate): JsonRecord {
  const text = message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.content)
    .join("\n");
  const opaque = message.blocks
    .filter((block) => block.type === "custom")
    .flatMap((block) => {
      try {
        return [JSON.parse(block.content)];
      } catch {
        return [];
      }
    });

  return {
    ...template.original,
    type: typeof template.original.type === "string" ? template.original.type : "message",
    role: template.originalRole,
    content: template.contentWasString
      ? text
      : [{ type: template.textType, text }, ...opaque],
  };
}

function parseTools(raw: unknown): { tools: AgentTool[] | undefined; toolTemplate: ResponsesState["toolTemplate"] } {
  if (!Array.isArray(raw)) return { tools: undefined, toolTemplate: [] };
  const tools: AgentTool[] = [];
  const toolTemplate: ResponsesState["toolTemplate"] = [];
  for (const rawTool of raw) {
    const tool = asRecord(rawTool);
    if (tool?.type === "function" && typeof tool.name === "string") {
      tools.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: asRecord(tool.parameters) ?? {},
      });
      toolTemplate.push({ kind: "function" });
    } else {
      toolTemplate.push({ kind: "opaque", tool: rawTool });
    }
  }
  return { tools, toolTemplate };
}

function serializeTools(tools: AgentTool[], template: ResponsesState["toolTemplate"]): unknown[] {
  let index = 0;
  const out: unknown[] = template.map((entry) => {
    if (entry.kind === "opaque") return entry.tool;
    const tool = tools[index++];
    return tool ? serializeTool(tool) : undefined;
  }).filter((tool): tool is unknown => tool !== undefined);
  while (index < tools.length) out.push(serializeTool(tools[index++]));
  return out;
}

function serializeTool(tool: AgentTool): JsonRecord {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}
