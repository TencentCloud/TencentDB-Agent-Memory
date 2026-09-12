import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SeedRequest,
  SeedResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";

export type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SeedRequest,
  SeedResponse,
  SessionEndRequest,
  SessionEndResponse,
};

export interface PiAgentAdapterConfig {
  gatewayUrl: string;
  gatewayApiKey?: string;
  autoRecall: boolean;
  autoCapture: boolean;
  recallMaxChars: number;
  defaultUserId: string;
}

export interface PiAgentGatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface PiAgentSessionEvent {
  sessionId?: string;
  session_id?: string;
  sessionFile?: string;
  workspace?: string;
  cwd?: string;
  userId?: string;
  user_id?: string;
  prompt?: string;
  query?: string;
  messages?: PiAgentMessage[];
  conversation?: PiAgentMessage[];
  entries?: PiAgentSessionEntry[];
  systemPromptOptions?: {
    cwd?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PiAgentBeforeAgentStartEvent extends PiAgentSessionEvent {
  prompt?: string;
  systemPrompt?: string;
}

export interface PiAgentMessage {
  role: "user" | "assistant" | "toolResult" | "custom" | string;
  content: unknown;
  timestamp?: number | string;
  [key: string]: unknown;
}

export interface PiAgentSessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: PiAgentMessage;
  [key: string]: unknown;
}

export interface PiAgentSessionManager {
  getSessionFile?: () => string | undefined;
  getEntries?: () => PiAgentSessionEntry[];
  [key: string]: unknown;
}

export interface PiAgentExtensionContext {
  cwd?: string;
  sessionManager?: PiAgentSessionManager;
  ui?: {
    notify?: (message: string, kind?: string) => void | Promise<void>;
  };
  [key: string]: unknown;
}

export interface PiAgentToolEvent {
  sessionId?: string;
  session_id?: string;
  workspace?: string;
  cwd?: string;
  toolName?: string;
  tool_name?: string;
  result?: unknown;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface PiAgentContextInjection {
  context: string;
  sessionKey: string;
  source: "tencentdb-agent-memory";
}

export interface PiAgentCustomMessage {
  customType: "tencentdb-agent-memory";
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

export interface PiAgentBeforeAgentStartResult {
  message?: PiAgentCustomMessage;
  systemPrompt?: string;
}

export interface PiAgentSessionEndResult {
  captured: boolean;
  l0Recorded?: number;
  skippedReason?: string;
}

export interface PiAgentMemorySearchArgs {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface PiAgentConversationSearchArgs {
  query: string;
  limit?: number;
  sessionKey?: string;
  session_key?: string;
}

export interface PiAgentContextGetArgs {
  sessionId?: string;
  session_id?: string;
  workspace?: string;
  cwd?: string;
}

export type PiAgentToolName =
  | "memory_search"
  | "conversation_search"
  | "context_get";

export interface PiAgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface PiAgentToolDefinition {
  name: PiAgentToolName;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: PiAgentToolResult) => void,
    ctx?: PiAgentExtensionContext,
  ) => PiAgentToolResult | Promise<PiAgentToolResult>;
}

export interface PiAgentRuntime {
  on?: (eventName: string, handler: (event: unknown, ctx?: PiAgentExtensionContext) => unknown | Promise<unknown>) => void;
  registerTool?: (definition: PiAgentToolDefinition) => void;
  registerCommand?: (name: string, options: { description?: string; handler: (args: string, ctx: PiAgentExtensionContext) => unknown | Promise<unknown> }) => void;
}

export type PiAgentContextInjector = (
  context: PiAgentContextInjection,
  event: PiAgentSessionEvent,
  ctx?: PiAgentExtensionContext,
) => void | Promise<void>;