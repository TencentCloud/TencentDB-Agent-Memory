import type {
  GatewayMemoryClient,
  GatewayPlatformContext,
} from "../gateway-client/index.js";

export interface LangChainMessageLike {
  content?: unknown;
  role?: string;
  type?: string;
  _getType?: () => string;
}

export interface LangChainAgentState {
  messages?: LangChainMessageLike[];
}

export interface LangChainRuntimeLike {
  context?: unknown;
}

export interface LangChainMemoryMiddlewareDefinition {
  name: string;
  beforeAgent: (
    state: LangChainAgentState,
    runtime: LangChainRuntimeLike,
  ) => Promise<{ messages: LangChainMessageLike[] } | undefined>;
  afterAgent: (
    state: LangChainAgentState,
    runtime: LangChainRuntimeLike,
  ) => Promise<void>;
}

export type LangChainCreateMiddleware<TMiddleware> = (
  definition: LangChainMemoryMiddlewareDefinition,
) => TMiddleware;

export interface LangChainMemoryMiddlewareOptions {
  client: GatewayMemoryClient;
  resolveContext: (
    state: LangChainAgentState,
    runtime: LangChainRuntimeLike,
  ) => GatewayPlatformContext | Promise<GatewayPlatformContext>;
  /** Prefix used for the recalled system message. */
  recallPrefix?: string;
  /** Throw Gateway errors instead of allowing the agent run to continue. */
  failClosed?: boolean;
  logger?: Pick<Console, "warn">;
}

function messageType(message: LangChainMessageLike): string {
  return (message._getType?.() ?? message.type ?? message.role ?? "").toLowerCase();
}

function messageText(message: LangChainMessageLike | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";

  return message.content
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

function isHuman(message: LangChainMessageLike): boolean {
  return ["human", "user"].includes(messageType(message));
}

function isAi(message: LangChainMessageLike): boolean {
  return ["ai", "assistant"].includes(messageType(message));
}

function normalizeMessages(messages: LangChainMessageLike[]): Array<{ role: string; content: string }> {
  return messages
    .map((message) => {
      const type = messageType(message);
      const role = type === "human" ? "user" : type === "ai" ? "assistant" : type;
      return { role, content: messageText(message) };
    })
    .filter((message) => message.role && message.content);
}

function findLastMessage(
  messages: LangChainMessageLike[],
  predicate: (message: LangChainMessageLike) => boolean,
  before = messages.length,
): { index: number; text: string } | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!predicate(message)) continue;
    const text = messageText(message);
    if (text) return { index, text };
  }
  return undefined;
}

/**
 * Create LangChain v1 middleware backed by the TDAI Gateway.
 *
 * `createMiddleware` is injected so the core package does not need to depend
 * on LangChain. Pass the function exported by the host application's installed
 * `langchain` package.
 */
export function createTdaiLangChainMiddleware<TMiddleware>(
  createMiddleware: LangChainCreateMiddleware<TMiddleware>,
  opts: LangChainMemoryMiddlewareOptions,
): TMiddleware {
  const handleFailure = (operation: string, error: unknown): void => {
    if (opts.failClosed) throw error;
    opts.logger?.warn(`[memory-tdai][langchain] ${operation} failed; continuing without memory`, error);
  };

  return createMiddleware({
    name: "TdaiMemoryMiddleware",

    async beforeAgent(state, runtime) {
      const messages = state.messages ?? [];
      const userMessage = findLastMessage(messages, isHuman);
      if (!userMessage) return undefined;

      try {
        const context = await opts.resolveContext(state, runtime);
        const recall = await opts.client.recall({
          query: userMessage.text,
          session_key: context.sessionKey,
          user_id: context.userId,
        });
        if (!recall.context.trim()) return undefined;

        return {
          messages: [{
            role: "system",
            content: `${opts.recallPrefix ?? "Relevant long-term memory:"}\n${recall.context}`,
          }],
        };
      } catch (error) {
        handleFailure("recall", error);
        return undefined;
      }
    },

    async afterAgent(state, runtime) {
      const messages = state.messages ?? [];
      const assistantMessage = findLastMessage(messages, isAi);
      if (!assistantMessage) return;
      const userMessage = findLastMessage(messages, isHuman, assistantMessage.index);
      if (!userMessage) return;

      try {
        const context = await opts.resolveContext(state, runtime);
        await opts.client.capture({
          user_content: userMessage.text,
          assistant_content: assistantMessage.text,
          // LangChain BaseMessage methods are not JSON-serializable. Preserve
          // their semantic role explicitly before crossing the HTTP boundary.
          messages: normalizeMessages(messages),
          session_key: context.sessionKey,
          session_id: context.sessionId,
          user_id: context.userId,
        });
      } catch (error) {
        handleFailure("capture", error);
      }
    },
  });
}
