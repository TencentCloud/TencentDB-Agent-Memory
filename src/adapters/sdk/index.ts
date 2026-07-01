/**
 * Unified Gateway-backed adapter SDK.
 *
 * New platforms only need to implement `MemoryPlatformAdapter`; this SDK handles
 * the HTTP contract with the TencentDB Agent Memory Gateway and provides a
 * consistent recall/capture/search runtime for hooks or wrapper scripts.
 */

export interface MemoryAdapterSession {
  /** Stable conversation key. Used by the memory backend for L0/L1 grouping. */
  sessionKey: string;
  /** Optional narrower sub-session id. */
  sessionId?: string;
  /** Optional platform user id. */
  userId?: string;
  /** Optional workspace/project directory. */
  workspaceDir?: string;
  /** Optional human-readable platform name. */
  platform?: string;
}

export interface MemoryCompletedTurn {
  userText: string;
  assistantText: string;
  messages?: unknown[];
  session?: Partial<MemoryAdapterSession>;
}

export interface MemoryPlatformAdapter<TTurn = unknown> {
  /** Return the current platform session identity. */
  getSession(): MemoryAdapterSession | Promise<MemoryAdapterSession>;
  /** Extract the user text from a platform-specific turn/request object. */
  getUserText(turn: TTurn): string | Promise<string>;
  /** Extract the assistant text after a turn completes. */
  getAssistantText(turn: TTurn): string | Promise<string>;
  /** Optional raw message list for richer L0 capture. */
  getMessages?(turn: TTurn): unknown[] | Promise<unknown[]>;
}

export interface GatewayClientOptions {
  gatewayUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface RecallOptions {
  query: string;
  session?: Partial<MemoryAdapterSession>;
}

export interface RecallResult {
  /** Combined context for simple clients. */
  context: string;
  /** Dynamic per-turn memories, when returned by the Gateway. */
  prependContext?: string;
  /** Stable persona/scene/tool context, when returned by the Gateway. */
  systemContext?: string;
  strategy?: string;
  memoryCount?: number;
}

export interface CaptureResult {
  l0Recorded: number;
  schedulerNotified: boolean;
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface MemorySearchResult {
  results: string;
  total: number;
  strategy?: string;
}

export interface ConversationSearchOptions {
  query: string;
  limit?: number;
  session?: Partial<MemoryAdapterSession>;
}

export interface ConversationSearchResult {
  results: string;
  total: number;
}

export interface ContextCompactionOptions {
  messages: unknown[];
  targetTokens: number;
  systemPrompt?: string | null;
  prompt?: string | null;
}

export interface ContextCompactionResult {
  messages: unknown[];
  compacted: boolean;
  deletedCount: number;
  deletedToolCallIds: string[];
  tokensBefore: number;
  tokensAfter: number;
}

interface GatewayRecallResponse {
  context?: string;
  prepend_context?: string;
  system_context?: string;
  strategy?: string;
  memory_count?: number;
}

interface GatewayCaptureResponse {
  l0_recorded?: number;
  scheduler_notified?: boolean;
}

interface GatewayMemorySearchResponse {
  results?: string;
  total?: number;
  strategy?: string;
}

interface GatewayConversationSearchResponse {
  results?: string;
  total?: number;
}

interface GatewayErrorResponse {
  error?: string;
  message?: string;
}

function normalizeGatewayUrl(url: string | undefined): string {
  return (url || process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420").replace(/\/+$/, "");
}

function mergeSession(base: MemoryAdapterSession, override?: Partial<MemoryAdapterSession>): MemoryAdapterSession {
  return { ...base, ...override, sessionKey: override?.sessionKey || base.sessionKey };
}

function requireSessionKey(session: MemoryAdapterSession): void {
  if (!session.sessionKey || !session.sessionKey.trim()) {
    throw new Error("Memory adapter sessionKey is required");
  }
}

export class MemoryGatewayClient {
  private readonly gatewayUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions = {}) {
    this.gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
    this.apiKey = options.apiKey ?? process.env.TDAI_GATEWAY_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<unknown> {
    const response = await this.fetchImpl(`${this.gatewayUrl}/health`);
    return await this.parseResponse<unknown>(response);
  }

  async recall(query: string, session: MemoryAdapterSession): Promise<RecallResult> {
    requireSessionKey(session);
    const response = await this.post<GatewayRecallResponse>("/recall", {
      query,
      session_key: session.sessionKey,
      session_id: session.sessionId,
      user_id: session.userId,
    });
    return {
      context: response.context ?? "",
      prependContext: response.prepend_context,
      systemContext: response.system_context,
      strategy: response.strategy,
      memoryCount: response.memory_count ?? 0,
    };
  }

  async capture(turn: MemoryCompletedTurn, session: MemoryAdapterSession): Promise<CaptureResult> {
    requireSessionKey(session);
    const response = await this.post<GatewayCaptureResponse>("/capture", {
      user_content: turn.userText,
      assistant_content: turn.assistantText,
      session_key: session.sessionKey,
      session_id: session.sessionId,
      user_id: session.userId,
      messages: turn.messages ?? [
        { role: "user", content: turn.userText },
        { role: "assistant", content: turn.assistantText },
      ],
    });
    return {
      l0Recorded: response.l0_recorded ?? 0,
      schedulerNotified: Boolean(response.scheduler_notified),
    };
  }

  async searchMemories(options: MemorySearchOptions): Promise<MemorySearchResult> {
    const response = await this.post<GatewayMemorySearchResponse>("/search/memories", {
      query: options.query,
      limit: options.limit,
      type: options.type,
      scene: options.scene,
    });
    return {
      results: response.results ?? "",
      total: response.total ?? 0,
      strategy: response.strategy,
    };
  }

  async searchConversations(options: ConversationSearchOptions, session: MemoryAdapterSession): Promise<ConversationSearchResult> {
    const effectiveSession = mergeSession(session, options.session);
    requireSessionKey(effectiveSession);
    const response = await this.post<GatewayConversationSearchResponse>("/search/conversations", {
      query: options.query,
      limit: options.limit,
      session_key: effectiveSession.sessionKey,
    });
    return {
      results: response.results ?? "",
      total: response.total ?? 0,
    };
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.gatewayUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as T : {} as T;
    if (!response.ok) {
      const err = parsed as GatewayErrorResponse;
      throw new Error(err.error ?? err.message ?? `Gateway request failed with HTTP ${response.status}`);
    }
    return parsed;
  }
}

export class MemoryAdapterRuntime<TTurn = unknown> {
  readonly platform: MemoryPlatformAdapter<TTurn>;
  readonly client: MemoryGatewayClient;

  constructor(platform: MemoryPlatformAdapter<TTurn>, options: GatewayClientOptions = {}) {
    this.platform = platform;
    this.client = new MemoryGatewayClient(options);
  }

  async recallForTurn(turn: TTurn, sessionOverride?: Partial<MemoryAdapterSession>): Promise<RecallResult> {
    const [baseSession, query] = await Promise.all([
      this.platform.getSession(),
      this.platform.getUserText(turn),
    ]);
    return this.client.recall(query, mergeSession(baseSession, sessionOverride));
  }

  async captureTurn(turn: TTurn, sessionOverride?: Partial<MemoryAdapterSession>): Promise<CaptureResult> {
    const [baseSession, userText, assistantText, messages] = await Promise.all([
      this.platform.getSession(),
      this.platform.getUserText(turn),
      this.platform.getAssistantText(turn),
      this.platform.getMessages?.(turn),
    ]);
    const session = mergeSession(baseSession, sessionOverride);
    return this.client.capture({ userText, assistantText, messages, session }, session);
  }

  async searchMemories(options: MemorySearchOptions): Promise<MemorySearchResult> {
    return this.client.searchMemories(options);
  }

  async searchConversations(options: ConversationSearchOptions): Promise<ConversationSearchResult> {
    const session = await this.platform.getSession();
    return this.client.searchConversations(options, session);
  }

  compactContext(options: ContextCompactionOptions): ContextCompactionResult {
    return compactContext(options);
  }
}

export function compactContext(options: ContextCompactionOptions): ContextCompactionResult {
  const messages = options.messages.map((message) => cloneMessage(message));
  const before = estimateContextTokens(messages, options.systemPrompt, options.prompt);
  const deletedToolCallIds: string[] = [];
  let deletedCount = 0;

  while (messages.length > 2 && estimateContextTokens(messages, options.systemPrompt, options.prompt) > options.targetTokens) {
    const deleteIndex = chooseDeletionIndex(messages);
    const [deleted] = messages.splice(deleteIndex, 1);
    deletedCount += 1;
    const toolCallId = extractToolCallId(deleted);
    if (toolCallId) deletedToolCallIds.push(toolCallId);
  }

  const after = estimateContextTokens(messages, options.systemPrompt, options.prompt);
  return {
    messages,
    compacted: deletedCount > 0 || after < before,
    deletedCount,
    deletedToolCallIds,
    tokensBefore: before,
    tokensAfter: after,
  };
}

function chooseDeletionIndex(messages: unknown[]): number {
  const lastIndex = messages.length - 1;
  let bestIndex = 1;
  let bestTokens = -1;
  for (let i = 1; i < lastIndex; i++) {
    const tokens = estimateTokens(JSON.stringify(messages[i]));
    if (tokens > bestTokens) {
      bestIndex = i;
      bestTokens = tokens;
    }
  }
  return bestIndex;
}

function extractToolCallId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  const direct = record.toolCallId ?? record.tool_call_id ?? record.id;
  return typeof direct === "string" ? direct : undefined;
}

function estimateContextTokens(messages: unknown[], systemPrompt?: string | null, prompt?: string | null): number {
  return estimateTokens(JSON.stringify(messages)) + estimateTokens(systemPrompt ?? "") + estimateTokens(prompt ?? "");
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function cloneMessage(message: unknown): unknown {
  if (message == null || typeof message !== "object") return message;
  return JSON.parse(JSON.stringify(message));
}
export function createMemoryAdapter<TTurn = unknown>(
  platform: MemoryPlatformAdapter<TTurn>,
  options: GatewayClientOptions = {},
): MemoryAdapterRuntime<TTurn> {
  return new MemoryAdapterRuntime(platform, options);
}
