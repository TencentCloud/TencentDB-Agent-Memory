import { PiAgentMemoryAdapter, type PiAgentMemoryAdapterOptions } from "./adapter.js";
import type {
  PiAgentConversationSearchArgs,
  PiAgentContextGetArgs,
  PiAgentMemorySearchArgs,
  PiAgentRuntime,
  PiAgentToolDefinition,
  PiAgentToolResult,
} from "./types.js";

function textResult(text: string): PiAgentToolResult {
  return { content: [{ type: "text", text }] };
}

function stringParam(description: string) {
  return { type: "string", description };
}

function numberParam(description: string) {
  return { type: "number", description };
}

function makeMemorySearchTool(adapter: PiAgentMemoryAdapter): PiAgentToolDefinition {
  return {
    name: "memory_search",
    label: "Search TencentDB long-term memory",
    description: "Search TencentDB-Agent-Memory long-term semantic memories for Pi Agent.",
    promptSnippet: "Use memory_search when the user asks about durable preferences, project history, or prior decisions.",
    promptGuidelines: [
      "Call memory_search before answering questions that may depend on durable memory.",
      "Keep queries concise and include project-specific terms when available.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: stringParam("Search query."),
        limit: numberParam("Maximum number of memories to return. Defaults to 5, capped at 20."),
        type: stringParam("Optional memory type filter, such as atom, scenario, or persona."),
        scene: stringParam("Optional scenario or scene filter."),
      },
    },
    execute: async (_toolCallId, params) => textResult(await adapter.memorySearch(params as PiAgentMemorySearchArgs)),
  };
}

function makeConversationSearchTool(adapter: PiAgentMemoryAdapter): PiAgentToolDefinition {
  return {
    name: "conversation_search",
    label: "Search TencentDB conversations",
    description: "Search raw L0 conversations captured by TencentDB-Agent-Memory.",
    promptSnippet: "Use conversation_search when exact previous conversation evidence is needed.",
    promptGuidelines: [
      "Prefer conversation_search for quoted or chronology-sensitive recall.",
      "Use memory_search for synthesized long-term facts.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: stringParam("Search query."),
        limit: numberParam("Maximum number of conversations to return. Defaults to 5, capped at 20."),
        sessionKey: stringParam("Optional TencentDB-Agent-Memory session key."),
        session_key: stringParam("Optional TencentDB-Agent-Memory session key."),
      },
    },
    execute: async (_toolCallId, params) => textResult(await adapter.conversationSearch(params as PiAgentConversationSearchArgs)),
  };
}

function makeContextGetTool(adapter: PiAgentMemoryAdapter): PiAgentToolDefinition {
  return {
    name: "context_get",
    label: "Get Pi Agent short-term context",
    description: "Reserved entry point for Pi Agent short-term context retrieval.",
    promptSnippet: "context_get is currently reserved and reports that short-term Pi context is not enabled in v1.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: stringParam("Optional Pi session id."),
        session_id: stringParam("Optional Pi session id."),
        workspace: stringParam("Optional workspace path."),
        cwd: stringParam("Optional working directory."),
      },
    },
    execute: (_toolCallId, params) => textResult(adapter.contextGet(params as PiAgentContextGetArgs)),
  };
}

export function registerPiAgentMemoryExtension(
  pi: PiAgentRuntime,
  options: PiAgentMemoryAdapterOptions = {},
): PiAgentMemoryAdapter {
  const adapter = new PiAgentMemoryAdapter(options);

  pi.on?.("before_agent_start", (event, ctx) => adapter.onBeforeAgentStart(event as Parameters<typeof adapter.onBeforeAgentStart>[0], ctx));
  pi.on?.("session_shutdown", (event, ctx) => adapter.onSessionShutdown(event as Parameters<typeof adapter.onSessionShutdown>[0], ctx));
  pi.on?.("tool_result", (event) => adapter.onToolResult(event as Parameters<typeof adapter.onToolResult>[0]));

  pi.registerTool?.(makeMemorySearchTool(adapter));
  pi.registerTool?.(makeConversationSearchTool(adapter));
  pi.registerTool?.(makeContextGetTool(adapter));

  return adapter;
}

export default registerPiAgentMemoryExtension;