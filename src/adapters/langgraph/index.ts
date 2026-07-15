import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  MemorySearchRequest,
  MemorySearchResponse,
} from "../../gateway/types.js";
import {
  createGatewayPlatformAdapter,
  type GatewayMemoryClient,
  type GatewayPlatformContext,
} from "../gateway-client/index.js";

export interface LangGraphMessageLike {
  content?: unknown;
  role?: string;
  type?: string;
  _getType?: () => string;
  [key: string]: unknown;
}

export interface LangGraphStateLike {
  messages?: LangGraphMessageLike[];
  [key: string]: unknown;
}

export interface LangGraphRuntimeLike {
  configurable?: Record<string, unknown>;
  context?: unknown;
  metadata?: Record<string, unknown>;
  runId?: unknown;
  [key: string]: unknown;
}

export interface LangGraphCompletedTurn {
  userText: string;
  assistantText: string;
  messages: Array<{ role: string; content: string }>;
}

export interface LangGraphMemoryAdapterOptions<
  TState extends LangGraphStateLike = LangGraphStateLike,
> {
  client: GatewayMemoryClient;
  /** State field populated by the recall node. Defaults to `memoryContext`. */
  contextKey?: string;
  /** Override the default thread/session identity mapping. */
  resolveContext?: (
    state: TState,
    runtime: LangGraphRuntimeLike,
  ) => GatewayPlatformContext | Promise<GatewayPlatformContext>;
  /** Override how the recall query is selected from graph state. */
  selectQuery?: (
    state: TState,
    runtime: LangGraphRuntimeLike,
  ) => string | undefined | Promise<string | undefined>;
  /** Override how the completed turn is selected for capture. */
  selectCompletedTurn?: (
    state: TState,
    runtime: LangGraphRuntimeLike,
  ) => LangGraphCompletedTurn | undefined | Promise<LangGraphCompletedTurn | undefined>;
  /** Throw Gateway errors instead of allowing the graph to continue. */
  failClosed?: boolean;
  logger?: Pick<Console, "warn">;
}

export interface LangGraphMemoryAdapter<
  TState extends LangGraphStateLike = LangGraphStateLike,
> {
  recallNode(
    state: TState,
    runtime?: LangGraphRuntimeLike,
  ): Promise<Record<string, unknown>>;
  captureNode(
    state: TState,
    runtime?: LangGraphRuntimeLike,
  ): Promise<Record<string, never>>;
  endSessionNode(
    state: TState,
    runtime?: LangGraphRuntimeLike,
  ): Promise<Record<string, never>>;
  searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse>;
  searchConversations(
    params: Omit<ConversationSearchRequest, "session_key"> & {
      sessionKey?: string;
    },
    state: TState,
    runtime?: LangGraphRuntimeLike,
  ): Promise<ConversationSearchResponse>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function messageRole(message: LangGraphMessageLike): string {
  const type = firstString(message._getType?.(), message.type, message.role)?.toLowerCase() ?? "";
  if (type === "human") return "user";
  if (type === "ai") return "assistant";
  return type;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && "text" in content) {
    return typeof content.text === "string" ? content.text.trim() : "";
  }
  return "";
}

function findLastMessage(
  messages: LangGraphMessageLike[],
  role: "user" | "assistant",
  before = messages.length,
): { index: number; text: string } | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageRole(message) !== role) continue;
    const text = contentText(message.content);
    if (text) return { index, text };
  }
  return undefined;
}

export function normalizeLangGraphMessages(
  messages: LangGraphMessageLike[],
): Array<{ role: string; content: string }> {
  return messages
    .map((message) => ({
      role: messageRole(message),
      content: contentText(message.content),
    }))
    .filter((message) => message.role && message.content);
}

export function selectLangGraphRecallQuery(state: LangGraphStateLike): string | undefined {
  return findLastMessage(state.messages ?? [], "user")?.text;
}

export function selectLangGraphCompletedTurn(
  state: LangGraphStateLike,
): LangGraphCompletedTurn | undefined {
  const messages = state.messages ?? [];
  const latestUser = findLastMessage(messages, "user");
  const assistant = findLastMessage(messages, "assistant");
  if (!latestUser || !assistant || latestUser.index > assistant.index) return undefined;
  const user = findLastMessage(messages, "user", assistant.index);
  if (!user) return undefined;

  return {
    userText: user.text,
    assistantText: assistant.text,
    messages: normalizeLangGraphMessages(messages.slice(0, assistant.index + 1)),
  };
}

export function resolveLangGraphPlatformContext(
  state: LangGraphStateLike,
  runtime: LangGraphRuntimeLike = {},
): GatewayPlatformContext {
  const configurable = asRecord(runtime.configurable);
  const context = asRecord(runtime.context);
  const metadata = asRecord(runtime.metadata);

  const sessionKey = firstString(
    configurable.session_key,
    configurable.sessionKey,
    configurable.thread_id,
    configurable.threadId,
    context.session_key,
    context.sessionKey,
    context.thread_id,
    context.threadId,
    state.session_key,
    state.sessionKey,
    state.thread_id,
    state.threadId,
  );
  if (!sessionKey) {
    throw new Error(
      "LangGraph memory requires a stable thread_id or sessionKey in runtime.configurable, runtime.context, or state",
    );
  }

  const sessionId = firstString(
    configurable.session_id,
    configurable.sessionId,
    configurable.run_id,
    configurable.runId,
    context.session_id,
    context.sessionId,
    context.run_id,
    context.runId,
    metadata.run_id,
    metadata.runId,
    runtime.runId,
    state.session_id,
    state.sessionId,
  ) ?? sessionKey;

  const userId = firstString(
    configurable.user_id,
    configurable.userId,
    context.user_id,
    context.userId,
    metadata.user_id,
    metadata.userId,
    state.user_id,
    state.userId,
  );

  return { sessionKey, sessionId, userId };
}

export function createLangGraphMemoryAdapter<
  TState extends LangGraphStateLike = LangGraphStateLike,
>(
  opts: LangGraphMemoryAdapterOptions<TState>,
): LangGraphMemoryAdapter<TState> {
  const contextKey = opts.contextKey?.trim() || "memoryContext";
  const logger = opts.logger ?? console;
  const resolveContext = opts.resolveContext ?? resolveLangGraphPlatformContext;
  const selectQuery = opts.selectQuery ?? selectLangGraphRecallQuery;
  const selectCompletedTurn = opts.selectCompletedTurn ?? selectLangGraphCompletedTurn;

  const runtimeOrEmpty = (runtime?: LangGraphRuntimeLike): LangGraphRuntimeLike => runtime ?? {};

  const gatewayFor = (state: TState, runtime: LangGraphRuntimeLike) =>
    createGatewayPlatformAdapter({
      client: opts.client,
      platform: "langgraph",
      resolveContext: () => resolveContext(state, runtime),
    });

  const recover = async <T>(
    operation: string,
    fallback: T,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (opts.failClosed) throw error;
      logger.warn(`[memory-tdai][langgraph] ${operation} failed; continuing without memory`, error);
      return fallback;
    }
  };

  return {
    async recallNode(state, runtime) {
      const activeRuntime = runtimeOrEmpty(runtime);
      const emptyResult = { [contextKey]: "" };

      return recover("recall", emptyResult, async () => {
        const query = await selectQuery(state, activeRuntime);
        if (!query?.trim()) return emptyResult;
        const recall = await gatewayFor(state, activeRuntime).prefetch(query.trim());
        return { [contextKey]: recall.context };
      });
    },

    async captureNode(state, runtime) {
      const activeRuntime = runtimeOrEmpty(runtime);

      return recover("capture", {}, async () => {
        const turn = await selectCompletedTurn(state, activeRuntime);
        if (!turn) return {};
        await gatewayFor(state, activeRuntime).captureTurn({
          userText: turn.userText,
          assistantText: turn.assistantText,
          messages: turn.messages,
        });
        return {};
      });
    },

    async endSessionNode(state, runtime) {
      const activeRuntime = runtimeOrEmpty(runtime);
      return recover("session end", {}, async () => {
        await gatewayFor(state, activeRuntime).endSession();
        return {};
      });
    },

    searchMemories(params) {
      return opts.client.searchMemories(params);
    },

    searchConversations(params, state, runtime) {
      return gatewayFor(state, runtimeOrEmpty(runtime)).searchConversations(params);
    },
  };
}
