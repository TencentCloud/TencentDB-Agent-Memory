//#region src/adapters/gateway-client/types.d.ts
interface GatewayMemoryClientOptions {
  /** Gateway root. A loopback URL is required unless allowRemote is true. */
  baseUrl?: string;
  /** Optional Bearer token matching TDAI_GATEWAY_API_KEY on the Gateway. */
  apiKey?: string;
  serviceId?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Explicitly permit a non-loopback Gateway URL. */
  allowRemote?: boolean;
  /** Injectable fetch implementation for tests and non-Node runtimes. */
  fetch?: typeof globalThis.fetch;
}
interface GatewayHealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}
interface GatewayRecallInput {
  query: string;
  sessionKey: string;
  sessionId?: string;
  teamId: string;
  agentId: string;
  userId?: string;
}
interface GatewayRecallResponse {
  /** Legacy stable-context field retained by the Gateway for compatibility. */
  context: string;
  /** Dynamic L1 context intended to accompany the current user turn. */
  prepend_context?: string;
  /** Stable L2/L3 context intended for the host's system context. */
  append_system_context?: string;
  strategy?: string;
  memory_count?: number;
}
interface GatewayCaptureMessage {
  role: string;
  content: string;
  timestamp?: number;
  [key: string]: unknown;
}
interface GatewayCaptureInput {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  teamId: string;
  agentId: string;
  userId?: string;
  messages?: GatewayCaptureMessage[];
}
interface GatewayCaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}
interface GatewayMemorySearchInput {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string;
}
interface GatewayMemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}
interface GatewayConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string;
}
interface GatewayConversationSearchResponse {
  results: string;
  total: number;
}
interface GatewaySessionEndInput {
  sessionKey: string;
  userId?: string;
}
interface GatewaySessionEndResponse {
  flushed: boolean;
}
interface SessionIdentity {
  sessionKey: string;
  sessionId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
}
interface CompletedPlatformTurn {
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
interface PlatformBinding<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput> {
  getSessionIdentity(event: TPromptEvent | TTurnEvent | TSessionEvent): SessionIdentity;
  getRecallQuery(event: TPromptEvent): string;
  getCompletedTurn(event: TTurnEvent): CompletedPlatformTurn | null;
  formatRecall(response: GatewayRecallResponse, event: TPromptEvent): TRecallOutput;
}
interface GatewayPlatformAdapter<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput> {
  beforePrompt(event: TPromptEvent): Promise<TRecallOutput>;
  turnCommitted(event: TTurnEvent): Promise<GatewayCaptureResponse | null>;
  sessionEnd(event: TSessionEvent): Promise<GatewaySessionEndResponse>;
  readonly client: GatewayMemoryClient;
}
//#endregion
//#region src/adapters/gateway-client/client.d.ts
declare class GatewayMemoryClient {
  private readonly baseUrl;
  private readonly apiKey?;
  private readonly timeoutMs;
  private readonly fetchImpl;
  constructor(options?: GatewayMemoryClientOptions);
  health(): Promise<GatewayHealthResponse>;
  recall(input: GatewayRecallInput): Promise<GatewayRecallResponse>;
  capture(input: GatewayCaptureInput): Promise<GatewayCaptureResponse>;
  searchMemories(input: GatewayMemorySearchInput): Promise<GatewayMemorySearchResponse>;
  searchConversations(input: GatewayConversationSearchInput): Promise<GatewayConversationSearchResponse>;
  endSession(input: GatewaySessionEndInput): Promise<GatewaySessionEndResponse>;
  private request;
}
//#endregion
//#region src/adapters/gateway-client/platform-adapter.d.ts
declare function createGatewayPlatformAdapter<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput>(binding: PlatformBinding<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput>, client: GatewayMemoryClient): GatewayPlatformAdapter<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput>;
//#endregion
//#region src/adapters/gateway-client/environment.d.ts
declare function gatewayClientOptionsFromEnv(env?: Record<string, string | undefined>): GatewayMemoryClientOptions;
//#endregion
//#region src/adapters/gateway-client/identity.d.ts
interface TdaiIdentity {
  serviceId: string;
  instanceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  sessionId: string;
  sessionKey: string;
}
interface ResolveTdaiIdentityOptions {
  env?: Record<string, string | undefined>;
  sessionId?: string;
}
declare function deriveTdaiSessionKey(identity: Omit<TdaiIdentity, "sessionKey">): string;
/**
 * Validate an identity supplied by an embedding caller such as the MCP
 * server. TypeScript types do not protect runtime/plugin boundaries, so the
 * derived session key is checked instead of trusting caller-controlled state.
 */
declare function assertTdaiIdentity(identity: unknown): TdaiIdentity;
/**
 * Resolve the strict identity shared by Codex hooks and MCP.
 *
 * Team, agent, and user deliberately have no fabricated defaults. The caller
 * decides whether a configuration error is fail-open (hooks) or user-visible
 * (MCP).
 */
declare function resolveTdaiIdentity(options?: ResolveTdaiIdentityOptions): TdaiIdentity;
//#endregion
//#region src/adapters/gateway-client/errors.d.ts
declare class GatewayMemoryClientError extends Error {
  constructor(message: string, options?: ErrorOptions);
}
declare class GatewayConfigurationError extends GatewayMemoryClientError {}
declare class GatewayTransportError extends GatewayMemoryClientError {
  readonly url: string;
  constructor(url: string, cause: unknown);
}
declare class GatewayTimeoutError extends GatewayTransportError {
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number, cause?: unknown);
}
/**
 * The Gateway attempted to redirect the request.
 *
 * Redirects are deliberately rejected so a trusted loopback URL cannot move a
 * request (and its Bearer token) to an unvalidated destination.
 */
declare class GatewayRedirectError extends GatewayMemoryClientError {
  readonly url: string;
  readonly status: number;
  readonly location?: string;
  constructor(url: string, status: number, location?: string);
}
declare class GatewayHttpError extends GatewayMemoryClientError {
  readonly status: number;
  readonly responseBody: string;
  readonly url: string;
  constructor(url: string, status: number, responseBody: string);
}
declare class GatewayResponseError extends GatewayMemoryClientError {
  readonly url: string;
  readonly responseBody: string;
  readonly reason?: string;
  constructor(url: string, responseBody: string, cause?: unknown, reason?: string);
}
/** The Gateway returned a successful HTTP response that was not valid JSON. */
declare class GatewayParseError extends GatewayResponseError {
  constructor(url: string, responseBody: string, cause?: unknown);
}
//#endregion
export { type CompletedPlatformTurn, type GatewayCaptureInput, type GatewayCaptureMessage, type GatewayCaptureResponse, GatewayConfigurationError, type GatewayConversationSearchInput, type GatewayConversationSearchResponse, type GatewayHealthResponse, GatewayHttpError, GatewayMemoryClient, GatewayMemoryClientError, type GatewayMemoryClientOptions, type GatewayMemorySearchInput, type GatewayMemorySearchResponse, GatewayParseError, type GatewayPlatformAdapter, type GatewayRecallInput, type GatewayRecallResponse, GatewayRedirectError, GatewayResponseError, type GatewaySessionEndInput, type GatewaySessionEndResponse, GatewayTimeoutError, GatewayTransportError, type PlatformBinding, type ResolveTdaiIdentityOptions, type SessionIdentity, type TdaiIdentity, assertTdaiIdentity, createGatewayPlatformAdapter, deriveTdaiSessionKey, gatewayClientOptionsFromEnv, resolveTdaiIdentity };
