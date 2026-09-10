export interface GatewayMemoryClientOptions {
  /** Gateway root. A loopback URL is required unless allowRemote is true. */
  baseUrl?: string;
  /** Optional Bearer token matching TDAI_GATEWAY_API_KEY on the Gateway. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Explicitly permit a non-loopback Gateway URL. */
  allowRemote?: boolean;
  /** Injectable fetch implementation for tests and non-Node runtimes. */
  fetch?: typeof globalThis.fetch;
}
export interface GatewayHealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

export interface GatewayRecallInput {
  query: string;
  sessionKey: string;
  userId?: string;
}

export interface GatewayRecallResponse {
  /** Legacy stable-context field retained by the Gateway for compatibility. */
  context: string;
  /** Dynamic L1 context intended to accompany the current user turn. */
  prepend_context?: string;
  /** Stable L2/L3 context intended for the host's system context. */
  append_system_context?: string;
  strategy?: string;
  memory_count?: number;
}

export interface GatewayCaptureMessage {
  role: string;
  content: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface GatewayCaptureInput {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  messages?: GatewayCaptureMessage[];
}

export interface GatewayCaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface GatewayMemorySearchInput {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface GatewayMemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

export interface GatewayConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface GatewayConversationSearchResponse {
  results: string;
  total: number;
}

export interface GatewaySessionEndInput {
  sessionKey: string;
  userId?: string;
}

export interface GatewaySessionEndResponse {
  flushed: boolean;
}

export interface SessionIdentity {
  sessionKey: string;
  sessionId?: string;
  userId?: string;
}

export interface CompletedPlatformTurn {
  userContent: string;
  assistantContent: string;
  messages?: GatewayCaptureMessage[];
}

/**
 * The only host-specific contract required by createGatewayPlatformAdapter.
 *
 * Hosts own event parsing and recall presentation. The SDK owns transport and
 * lifecycle-to-Gateway routing.
 */
export interface PlatformBinding<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput> {
  getSessionIdentity(event: TPromptEvent | TTurnEvent | TSessionEvent): SessionIdentity;
  getRecallQuery(event: TPromptEvent): string;
  getCompletedTurn(event: TTurnEvent): CompletedPlatformTurn | null;
  formatRecall(response: GatewayRecallResponse, event: TPromptEvent): TRecallOutput;
}

export interface GatewayPlatformAdapter<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput> {
  beforePrompt(event: TPromptEvent): Promise<TRecallOutput>;
  turnCommitted(event: TTurnEvent): Promise<GatewayCaptureResponse | null>;
  sessionEnd(event: TSessionEvent): Promise<GatewaySessionEndResponse>;
  readonly client: import("./client.js").GatewayMemoryClient;
}
