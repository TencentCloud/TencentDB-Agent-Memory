import { gatewayPost, type GatewayClientOptions } from "../../src/integrations/shared/gateway-client.js";

export interface LangGraphRuntimeLike {
  context?: Record<string, unknown>;
  configurable?: Record<string, unknown>;
}

export interface LangGraphMemoryContext {
  sessionKey: string;
  sessionId?: string;
  userId?: string;
}

export interface LangGraphMemoryTurnOptions {
  input: string;
  runtime?: LangGraphRuntimeLike;
  gateway?: GatewayClientOptions;
  model: (prompt: string, runtime?: LangGraphRuntimeLike) => Promise<string>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveLangGraphMemoryContext(runtime: LangGraphRuntimeLike = {}): LangGraphMemoryContext {
  const context = runtime.context ?? {};
  const configurable = runtime.configurable ?? {};
  const sessionKey = firstString(
    context.session_key,
    context.sessionKey,
    context.thread_id,
    context.threadId,
    configurable.session_key,
    configurable.sessionKey,
    configurable.thread_id,
    configurable.threadId,
  ) ?? "langgraph:default";
  const sessionId = firstString(
    context.session_id,
    context.sessionId,
    context.thread_id,
    context.threadId,
    configurable.session_id,
    configurable.sessionId,
    configurable.thread_id,
    configurable.threadId,
  );
  const userId = firstString(context.userId, context.user_id, configurable.userId, configurable.user_id);

  return { sessionKey, sessionId, userId };
}

export async function recallForLangGraph(
  input: string,
  runtime: LangGraphRuntimeLike = {},
  gateway: GatewayClientOptions = {},
): Promise<string> {
  const ctx = resolveLangGraphMemoryContext(runtime);
  const result = await gatewayPost<{ context?: string }>("/recall", {
    query: input,
    session_key: ctx.sessionKey,
    user_id: ctx.userId,
  }, gateway);
  return result.context ?? "";
}

export async function captureForLangGraph(
  input: string,
  answer: string,
  runtime: LangGraphRuntimeLike = {},
  gateway: GatewayClientOptions = {},
): Promise<unknown> {
  const ctx = resolveLangGraphMemoryContext(runtime);
  return gatewayPost("/capture", {
    user_content: input,
    assistant_content: answer,
    session_key: ctx.sessionKey,
    session_id: ctx.sessionId,
    user_id: ctx.userId,
    messages: [
      { role: "user", content: input },
      { role: "assistant", content: answer },
    ],
  }, gateway);
}

export async function runMemoryWrappedTurn(opts: LangGraphMemoryTurnOptions): Promise<{
  answer: string;
  memoryContext: string;
}> {
  const memoryContext = await recallForLangGraph(opts.input, opts.runtime, opts.gateway);
  const prompt = memoryContext ? `${memoryContext}\n\n${opts.input}` : opts.input;
  const answer = await opts.model(prompt, opts.runtime);
  await captureForLangGraph(opts.input, answer, opts.runtime, opts.gateway);
  return { answer, memoryContext };
}

export function createMemoryTencentDbSearchTool(gateway: GatewayClientOptions = {}) {
  return {
    name: "memory_tencentdb_search",
    description: "Search structured long-term memories from memory-tencentdb.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        type: { type: "string" },
        scene: { type: "string" },
      },
      required: ["query"],
    },
    async invoke(args: {
      query: string;
      limit?: number;
      type?: string;
      scene?: string;
    }): Promise<unknown> {
      return gatewayPost("/search/memories", {
        query: args.query,
        limit: args.limit,
        type: args.type,
        scene: args.scene,
      }, gateway);
    },
  };
}

