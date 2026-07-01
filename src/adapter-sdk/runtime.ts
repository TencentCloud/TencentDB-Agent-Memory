import { TdaiGatewayClient } from "./gateway-client.js";
import { asRecord, coerceSearchLimit, optionalString, requireString } from "./params.js";
import {
  toAdapterToolError,
  toAdapterToolResult,
} from "./results.js";
import type {
  AdapterEventEnvelope,
  AdapterCaptureResult,
  AdapterCompletedTurn,
  AdapterConversationSearchParams,
  AdapterMemorySearchParams,
  AdapterSdkLogger,
  AdapterToolCall,
  AdapterToolResult,
  AdapterRecallResult,
  MemoryAdapterOperations,
  TdaiPlatformAdapter,
} from "./types.js";

export interface TdaiAdapterRuntimeOptions<TEvent = unknown, TContext = unknown> {
  adapter?: TdaiPlatformAdapter<TEvent, TContext>;
  operations: MemoryAdapterOperations;
  logger?: AdapterSdkLogger;
}

export interface CoreMemoryOperationsOptions {
  core: {
    handleBeforeRecall(query: string, sessionKey: string): Promise<AdapterRecallResult>;
    handleTurnCommitted(turn: AdapterCompletedTurn): Promise<AdapterCaptureResult>;
    searchMemories(params: AdapterMemorySearchParams): Promise<{ text: string; total: number; strategy: string }>;
    searchConversations(params: AdapterConversationSearchParams): Promise<{ text: string; total: number }>;
    handleSessionEnd(sessionKey: string): Promise<void>;
    destroy(): Promise<void>;
  };
}

export interface GatewayMemoryOperationsOptions {
  client: TdaiGatewayClient;
  defaultSessionKey: string;
}

export class CoreMemoryOperations implements MemoryAdapterOperations {
  private readonly core: CoreMemoryOperationsOptions["core"];

  constructor(options: CoreMemoryOperationsOptions) {
    this.core = options.core;
  }

  async recall(query: string, sessionKey: string): Promise<AdapterRecallResult> {
    return this.core.handleBeforeRecall(query, sessionKey);
  }

  async capture(turn: AdapterCompletedTurn): Promise<AdapterCaptureResult> {
    const messages = turn.messages.length > 0
      ? turn.messages
      : [
        { role: "user", content: turn.userText, timestamp: Date.now() + 1 },
        { role: "assistant", content: turn.assistantText, timestamp: Date.now() + 2 },
      ];

    return this.core.handleTurnCommitted({ ...turn, messages });
  }

  async searchMemories(params: AdapterMemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    return this.core.searchMemories(params);
  }

  async searchConversations(params: AdapterConversationSearchParams): Promise<{ text: string; total: number }> {
    return this.core.searchConversations(params);
  }

  async endSession(sessionKey: string): Promise<void> {
    await this.core.handleSessionEnd(sessionKey);
  }

  async shutdown(): Promise<void> {
    await this.core.destroy();
  }
}

export class GatewayMemoryOperations implements MemoryAdapterOperations {
  private readonly client: TdaiGatewayClient;
  private readonly defaultSessionKey: string;

  constructor(options: GatewayMemoryOperationsOptions) {
    this.client = options.client;
    this.defaultSessionKey = options.defaultSessionKey;
  }

  async health(): Promise<unknown> {
    return this.client.health();
  }

  async recall(query: string, sessionKey: string, userId?: string): Promise<AdapterRecallResult> {
    const response = await this.client.recall({
      query,
      session_key: sessionKey,
      user_id: userId,
    }, this.defaultSessionKey);

    return {
      prependContext: response.prepend_context,
      appendSystemContext: response.append_system_context,
      recallStrategy: response.strategy,
    };
  }

  async capture(turn: AdapterCompletedTurn, userId?: string): Promise<AdapterCaptureResult> {
    const response = await this.client.captureTurn({
      userContent: turn.userText,
      assistantContent: turn.assistantText,
      sessionKey: turn.sessionKey,
      sessionId: turn.sessionId,
      userId,
      messages: turn.messages.length > 0 ? turn.messages : undefined,
    });

    return {
      l0RecordedCount: response.l0_recorded,
      schedulerNotified: response.scheduler_notified,
      l0VectorsWritten: 0,
      filteredMessages: [],
    };
  }

  async searchMemories(params: AdapterMemorySearchParams): Promise<{ text: string; total: number; strategy: string }> {
    const response = await this.client.searchMemories({
      query: params.query,
      limit: params.limit,
      type: params.type,
      scene: params.scene,
    });
    return {
      text: response.results,
      total: response.total,
      strategy: response.strategy,
    };
  }

  async searchConversations(params: AdapterConversationSearchParams): Promise<{ text: string; total: number }> {
    const response = await this.client.searchConversations({
      query: params.query,
      limit: params.limit,
      session_key: params.sessionKey,
    });
    return {
      text: response.results,
      total: response.total,
    };
  }

  async endSession(sessionKey: string, userId?: string): Promise<void> {
    await this.client.endSession({
      session_key: sessionKey,
      user_id: userId,
    }, this.defaultSessionKey);
  }
}

export class TdaiAdapterRuntime<TEvent = unknown, TContext = unknown> {
  private readonly adapter?: TdaiPlatformAdapter<TEvent, TContext>;
  private readonly operations: MemoryAdapterOperations;
  private readonly logger?: AdapterSdkLogger;

  constructor(options: TdaiAdapterRuntimeOptions<TEvent, TContext>) {
    this.adapter = options.adapter;
    this.operations = options.operations;
    this.logger = options.logger;
  }

  async handleRecall(envelope: AdapterEventEnvelope<TEvent, TContext>): Promise<unknown> {
    if (!this.adapter?.getRecallInput) return undefined;
    const session = this.adapter.getSession(envelope);
    const recallInput = this.adapter.getRecallInput(envelope);
    if (!session || !recallInput?.query) return undefined;

    try {
      const result = await this.operations.recall(recallInput.query, session.sessionKey, session.userId);
      return this.adapter.applyRecallResult
        ? this.adapter.applyRecallResult(result, envelope)
        : result;
    } catch (err) {
      this.adapter.onError?.("recall", err);
      this.logger?.error?.(`Adapter recall failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async handleCapture(envelope: AdapterEventEnvelope<TEvent, TContext>): Promise<AdapterCaptureResult | undefined> {
    if (!this.adapter?.getCaptureInput) return undefined;
    const session = this.adapter.getSession(envelope);
    const captureInput = this.adapter.getCaptureInput(envelope);
    if (!session || !captureInput?.userContent) return undefined;

    const messages = captureInput.messages ?? [];

    try {
      return await this.operations.capture({
        userText: captureInput.userContent,
        assistantText: captureInput.assistantContent ?? "",
        messages,
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        startedAt: captureInput.startedAt,
        originalUserMessageCount: captureInput.originalUserMessageCount,
      }, session.userId);
    } catch (err) {
      this.adapter.onError?.("capture", err);
      this.logger?.error?.(`Adapter capture failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async handleToolCall(call: AdapterToolCall, defaults?: { sessionKey?: string; userId?: string }): Promise<AdapterToolResult> {
    const args = asRecord(call.arguments);

    try {
      switch (call.name) {
        case "memory_tencentdb_health":
          return toAdapterToolResult(await this.operations.health?.());
        case "memory_tencentdb_recall": {
          const sessionKey = optionalString(args, "session_key") || defaults?.sessionKey;
          if (!sessionKey) throw new Error("Missing required argument: session_key");
          return toAdapterToolResult(await this.operations.recall(
            requireString(args, "query"),
            sessionKey,
            optionalString(args, "user_id") || defaults?.userId,
          ));
        }
        case "memory_tencentdb_capture": {
          const sessionKey = optionalString(args, "session_key") || defaults?.sessionKey;
          if (!sessionKey) throw new Error("Missing required argument: session_key");
          const userText = requireString(args, "user_content");
          const assistantText = requireString(args, "assistant_content");
          return toAdapterToolResult(await this.operations.capture({
            userText,
            assistantText,
            messages: Array.isArray(args.messages)
              ? args.messages
              : [],
            sessionKey,
            sessionId: optionalString(args, "session_id"),
            startedAt: Date.now(),
          }, optionalString(args, "user_id") || defaults?.userId));
        }
        case "memory_tencentdb_memory_search": {
          const result = await this.operations.searchMemories({
            query: requireString(args, "query"),
            limit: coerceSearchLimit(args.limit),
            type: optionalString(args, "type"),
            scene: optionalString(args, "scene"),
          });
          return { text: result.text, details: { count: result.total, strategy: result.strategy } };
        }
        case "memory_tencentdb_conversation_search": {
          const result = await this.operations.searchConversations({
            query: requireString(args, "query"),
            limit: coerceSearchLimit(args.limit),
            sessionKey: optionalString(args, "session_key"),
          });
          return { text: result.text, details: { count: result.total } };
        }
        case "memory_tencentdb_session_end": {
          const sessionKey = optionalString(args, "session_key") || defaults?.sessionKey;
          if (!sessionKey) throw new Error("Missing required argument: session_key");
          await this.operations.endSession(sessionKey, optionalString(args, "user_id") || defaults?.userId);
          return { text: JSON.stringify({ flushed: true }, null, 2), details: { flushed: true } };
        }
        default:
          return toAdapterToolError(`Unknown tool: ${call.name}`);
      }
    } catch (err) {
      this.adapter?.onError?.("tool", err);
      return toAdapterToolError(err);
    }
  }
}
