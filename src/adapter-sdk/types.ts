export type AdapterMode = "core" | "gateway";

export type AdapterPhase =
  | "initialize"
  | "recall"
  | "capture"
  | "memory_search"
  | "conversation_search"
  | "session_end"
  | "shutdown"
  | "tool";

export interface AdapterSession {
  sessionKey: string;
  sessionId?: string;
  userId?: string;
}

export interface AdapterEventEnvelope<TEvent = unknown, TContext = unknown> {
  event: TEvent;
  context: TContext;
}

export interface AdapterRecallInput {
  query: string;
}

export interface AdapterCaptureInput {
  userContent: string;
  assistantContent?: string;
  messages?: unknown[];
  startedAt?: number;
  originalUserMessageCount?: number;
}

export interface AdapterCompletedTurn {
  userText: string;
  assistantText: string;
  messages: unknown[];
  sessionKey: string;
  sessionId?: string;
  startedAt?: number;
  originalUserMessageCount?: number;
}

export interface AdapterRecallResult {
  prependContext?: string;
  appendSystemContext?: string;
  recalledL1Memories?: Array<{ content: string; score: number; type: string }>;
  recalledL3Persona?: string | null;
  recallStrategy?: string;
}

export interface AdapterCaptureResult {
  l0RecordedCount: number;
  schedulerNotified: boolean;
  l0VectorsWritten: number;
  filteredMessages: Array<{
    role: string;
    content: string;
    timestamp: number;
  }>;
}

export interface AdapterMemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface AdapterConversationSearchParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface AdapterToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface AdapterToolResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface AdapterSdkLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Single interface that a new platform implements.
 *
 * The SDK owns the memory operations and shared tool contract. A platform only
 * translates host events into session / recall / capture inputs and optionally
 * places recall output back into the host-specific prompt shape.
 */
export interface TdaiPlatformAdapter<TEvent = unknown, TContext = unknown> {
  readonly platform: string;

  getSession(input: AdapterEventEnvelope<TEvent, TContext>): AdapterSession | undefined;

  getRecallInput?(
    input: AdapterEventEnvelope<TEvent, TContext>,
  ): AdapterRecallInput | undefined;

  getCaptureInput?(
    input: AdapterEventEnvelope<TEvent, TContext>,
  ): AdapterCaptureInput | undefined;

  applyRecallResult?(
    result: AdapterRecallResult,
    input: AdapterEventEnvelope<TEvent, TContext>,
  ): unknown;

  onError?(phase: AdapterPhase, error: unknown): void;
}

export interface MemoryAdapterOperations {
  recall(query: string, sessionKey: string, userId?: string): Promise<AdapterRecallResult>;
  capture(turn: AdapterCompletedTurn, userId?: string): Promise<AdapterCaptureResult>;
  searchMemories(params: AdapterMemorySearchParams): Promise<{ text: string; total: number; strategy: string }>;
  searchConversations(params: AdapterConversationSearchParams): Promise<{ text: string; total: number }>;
  endSession(sessionKey: string, userId?: string): Promise<void>;
  health?(): Promise<unknown>;
  shutdown?(): Promise<void>;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CanonicalToolSpec {
  id:
    | "health"
    | "recall"
    | "capture"
    | "memory_search"
    | "conversation_search"
    | "session_end";
  gatewayName: string;
  openclawName?: string;
  label: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

export interface OpenClawToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}
