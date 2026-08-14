/**
 * Type declarations for the TDAI Adapter SDK (zero-dependency Node.js ESM).
 */

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const DEFAULT_GATEWAY_URL: string;
export const DEFAULT_TIMEOUT_MS: number;

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
}

export function resolveConfig(
  overrides?: { baseUrl?: string; apiKey?: string; timeoutMs?: number },
  env?: Record<string, string | undefined>,
): ResolvedConfig;

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------

export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export const silentLogger: Logger;
export function createLogger(opts?: { debug?: boolean; prefix?: string }): Logger;

// ---------------------------------------------------------------------------
// gateway-client (snake_case wire format per src/gateway/types.ts)
// ---------------------------------------------------------------------------

export class TdaiGatewayError extends Error {
  name: "TdaiGatewayError";
  status?: number;
  path?: string;
  cause?: unknown;
  constructor(message: string, opts?: { status?: number; path?: string; cause?: unknown });
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version?: string;
  uptime?: number;
  stores?: Record<string, unknown>;
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memory_count?: number;
}

export interface CaptureResponse {
  l0_recorded: boolean;
  scheduler_notified: boolean;
}

export interface SearchMemoriesResponse {
  results: unknown;
  total: number;
  strategy?: string;
}

export interface SearchConversationsResponse {
  results: unknown;
  total: number;
}

export interface SessionEndResponse {
  flushed: boolean;
}

export class TdaiGatewayClient {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  logger: Logger;

  constructor(opts?: {
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
    logger?: Logger;
  });

  health(timeoutMs?: number): Promise<HealthResponse>;
  recall(params: { query: string; sessionKey?: string; userId?: string }): Promise<RecallResponse>;
  capture(params: {
    userContent: string;
    assistantContent: string;
    sessionKey?: string;
    sessionId?: string;
    userId?: string;
    messages?: unknown[];
  }): Promise<CaptureResponse>;
  searchMemories(params: {
    query: string;
    limit?: number;
    type?: string;
    scene?: string;
  }): Promise<SearchMemoriesResponse>;
  searchConversations(params: {
    query: string;
    limit?: number;
    sessionKey?: string;
  }): Promise<SearchConversationsResponse>;
  endSession(params: { sessionKey: string; userId?: string }): Promise<SessionEndResponse>;
  seed(
    params: {
      data: unknown;
      sessionKey?: string;
      strictRoundRole?: boolean;
      autoFillTimestamps?: boolean;
      configOverride?: Record<string, unknown>;
    },
    timeoutMs?: number,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// platform-adapter (the standard interface for new platforms)
// ---------------------------------------------------------------------------

export interface RecallInput {
  query: string;
  sessionKey?: string;
}

export interface CaptureInput {
  userContent: string;
  assistantContent: string;
  sessionKey?: string;
}

/**
 * The minimal object a new platform must provide. Every method is optional;
 * omitted methods fall back to the Whale-shaped defaults in BasePlatformAdapter.
 */
export interface PlatformDescriptor {
  name: string;
  parseRecallPayload?(payload: unknown): RecallInput | null;
  parseCapturePayload?(payload: unknown): CaptureInput | null | Promise<CaptureInput | null>;
  formatRecallOutput?(context: string, payload: unknown): string;
  sessionKeyFrom?(payload: unknown): string;
}

export class BasePlatformAdapter {
  name: string;
  constructor(descriptor?: PlatformDescriptor);
  parseRecallPayload(payload: unknown): RecallInput | null;
  parseCapturePayload(payload: unknown): CaptureInput | null | Promise<CaptureInput | null>;
  formatRecallOutput(context: string, payload: unknown): string;
  sessionKeyFrom(payload: unknown): string;
}

export function defineAdapter(descriptor: PlatformDescriptor): BasePlatformAdapter;

// ---------------------------------------------------------------------------
// hook-runner
// ---------------------------------------------------------------------------

export function readStdin(stream?: NodeJS.ReadableStream): Promise<string>;

export function runHealthHook(
  client: TdaiGatewayClient,
  opts?: { timeoutMs?: number },
): Promise<boolean>;

export function runRecallHook(
  adapter: BasePlatformAdapter,
  client: TdaiGatewayClient,
  opts?: { payload?: unknown; stdin?: NodeJS.ReadableStream; write?: (s: string) => void },
): Promise<string | null>;

export function runCaptureHook(
  adapter: BasePlatformAdapter,
  client: TdaiGatewayClient,
  opts?: { payload?: unknown; stdin?: NodeJS.ReadableStream },
): Promise<boolean>;

export function runSessionEndHook(
  adapter: BasePlatformAdapter,
  client: TdaiGatewayClient,
  opts?: { payload?: unknown; stdin?: NodeJS.ReadableStream },
): Promise<boolean>;

// ---------------------------------------------------------------------------
// mcp-bridge
// ---------------------------------------------------------------------------

export interface McpBridge {
  start(): void;
  handle(message: unknown): Promise<void>;
  tools: unknown[];
}

export function createMcpBridge(opts: {
  client: TdaiGatewayClient;
  input?: NodeJS.ReadableStream;
  write?: (s: string) => void;
}): McpBridge;
