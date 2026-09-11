export type AgentSdkName = "codex-sdk" | "claude-code-sdk";

export type JsonRecord = Record<string, unknown>;

export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface GatewayEndpoints {
  gatewayUrl: string;
  apiKey?: string;
}

export interface MemoryPaths {
  rootDir: string;
  configPath: string;
  dataDir: string;
  logDir: string;
  runtimeDir: string;
}

export interface GatewaySupervisorOptions {
  agentSdkName: AgentSdkName;
  gatewayUrl?: string;
  apiKey?: string;
  rootDir?: string;
  dataDir?: string;
  configPath?: string;
  logDir?: string;
  runtimeDir?: string;
  gatewayCwd?: string;
  gatewayCommand?: string | string[];
  startupTimeoutMs?: number;
  healthPollMs?: number;
  requestTimeoutMs?: number;
  autoStart?: boolean;
  logger?: Logger;
}

export interface GatewaySupervisorLike {
  readonly endpoints: GatewayEndpoints;
  readonly paths: MemoryPaths;
  ensureRunning(): Promise<void>;
  close(): Promise<void>;
}

export interface RecallRequest {
  query: string;
  sessionKey: string;
  userId?: string;
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memoryCount?: number;
}

export interface CaptureRequest {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  startedAt?: number;
  messages?: unknown[];
}

export interface CaptureResponse {
  l0Recorded: number;
  schedulerNotified: boolean;
}

export interface SessionEndRequest {
  sessionKey: string;
  userId?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface MemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
}

export interface GatewayClientLike {
  health(): Promise<JsonRecord>;
  recall(request: RecallRequest): Promise<RecallResponse>;
  capture(request: CaptureRequest): Promise<CaptureResponse>;
  endSession(request: SessionEndRequest): Promise<SessionEndResponse>;
  searchMemories(request: MemorySearchRequest): Promise<MemorySearchResponse>;
  searchConversations(request: ConversationSearchRequest): Promise<ConversationSearchResponse>;
}

export interface AgentSdkRunInput {
  prompt: string;
  signal?: AbortSignal;
  metadata?: JsonRecord;
}

export type AgentSdkRawEvent = unknown;

export type AgentSdkStreamEvent =
  | { type: "agent.event"; event: AgentSdkRawEvent }
  | { type: "agent.text.delta"; text: string }
  | { type: "agent.completed"; result?: unknown; text?: string };

export interface AgentSdkRunResult {
  text: string;
  rawResult?: unknown;
  events?: AgentSdkStreamEvent[];
}

export interface AgentSdkSession {
  stream(input: AgentSdkRunInput): AsyncIterable<AgentSdkStreamEvent>;
  run?(input: AgentSdkRunInput): Promise<AgentSdkRunResult>;
  close?(): Promise<void>;
}

export interface AgentSdkDriver {
  readonly name: string;
  startSession(options?: AgentSdkSessionOptions): Promise<AgentSdkSession>;
}

export interface AgentSdkSessionOptions {
  sessionId?: string;
  userId?: string;
  metadata?: JsonRecord;
}

export type InjectMemory = (memoryText: string, userPrompt: string) => string;

export interface MemoryAgentOptions {
  driver: AgentSdkDriver;
  agentSdkName: AgentSdkName;
  gateway?: GatewayClientLike;
  supervisor?: GatewaySupervisorLike;
  gatewayOptions?: Omit<GatewaySupervisorOptions, "agentSdkName">;
  sessionKey?: string;
  userId?: string;
  strict?: boolean;
  injectMemory?: InjectMemory;
  logger?: Logger;
}

export interface MemoryAgentSessionOptions extends AgentSdkSessionOptions {
  sessionKey?: string;
}

export type MemoryAgentStreamEvent =
  | { type: "memory.recall"; context: string; strategy?: string; memoryCount?: number }
  | { type: "memory.injected"; prompt: string }
  | AgentSdkStreamEvent
  | { type: "memory.capture"; response: CaptureResponse }
  | { type: "memory.error"; phase: "recall" | "capture" | "session-end"; error: unknown };

export interface MemoryAgentRunResult {
  text: string;
  rawResult?: unknown;
  memory: {
    recalled: RecallResponse | null;
    captured: CaptureResponse | null;
  };
  events: MemoryAgentStreamEvent[];
}
