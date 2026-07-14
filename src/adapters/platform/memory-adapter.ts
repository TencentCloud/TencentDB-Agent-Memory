import { MemoryGatewayClient, type MemoryGatewayClientOptions } from "./gateway-client.js";
import type {
  MemoryAdapterRuntime,
  MemoryPlatformBridge,
  MemoryPromptContext,
  MemoryTurnPayload,
} from "./bridge.js";

export interface MemoryAdapterOptions extends MemoryGatewayClientOptions {
  bridge: MemoryPlatformBridge;
}

export class MemoryPlatformAdapter {
  protected readonly client: MemoryGatewayClient;
  protected readonly bridge: MemoryPlatformBridge;

  constructor(opts: MemoryAdapterOptions) {
    this.client = new MemoryGatewayClient(opts);
    this.bridge = opts.bridge;
  }

  getRuntime(): MemoryAdapterRuntime {
    return { ...this.bridge.getRuntime() };
  }

  async buildPromptContext(query: string): Promise<MemoryPromptContext> {
    const recall = await this.recall(query);
    return {
      prependUserContext: recall.prependContext,
      appendSystemContext: recall.appendSystemContext,
    };
  }

  async recall(query: string): Promise<{ prependContext: string; appendSystemContext: string; context: string }> {
    const runtime = this.bridge.getRuntime();
    const result = await this.client.recall(query, runtime.sessionKey, runtime.userId);
    return {
      context: result.context,
      prependContext: result.prependContext,
      appendSystemContext: result.appendSystemContext,
    };
  }

  async capture(turn: MemoryTurnPayload): Promise<{ l0Recorded: number; schedulerNotified: boolean }> {
    const runtime = this.bridge.getRuntime();
    const normalizedTurn = this.bridge.buildTurn?.(turn) ?? turn;
    const result = await this.client.capture({
      userContent: normalizedTurn.userContent,
      assistantContent: normalizedTurn.assistantContent,
      sessionKey: runtime.sessionKey,
      sessionId: runtime.sessionId,
      userId: runtime.userId,
      messages: normalizedTurn.messages,
    });
    return {
      l0Recorded: result.l0_recorded,
      schedulerNotified: result.scheduler_notified,
    };
  }

  async searchMemories(query: string, limit = 5, type?: string, scene?: string): Promise<{ results: string; total: number; strategy: string }> {
    const result = await this.client.searchMemories({ query, limit, type, scene });
    return { results: result.results, total: result.total, strategy: result.strategy };
  }

  async searchConversations(query: string, limit = 5): Promise<{ results: string; total: number }> {
    const runtime = this.bridge.getRuntime();
    const result = await this.client.searchConversations({ query, limit, sessionKey: runtime.sessionKey });
    return { results: result.results, total: result.total };
  }

  async endSession(): Promise<void> {
    const runtime = this.bridge.getRuntime();
    await this.client.endSession(runtime.sessionKey, runtime.userId);
  }

  async health(): Promise<{ status: string; version: string; uptime: number }> {
    return this.client.health();
  }

  async seed(data: unknown, params?: {
    sessionKey?: string;
    strictRoundRole?: boolean;
    autoFillTimestamps?: boolean;
    configOverride?: Record<string, unknown>;
  }): Promise<{ sessionsProcessed: number; roundsProcessed: number; messagesProcessed: number; l0Recorded: number; durationMs: number; outputDir: string }> {
    const result = await this.client.seed(data, params);
    return {
      sessionsProcessed: result.sessions_processed,
      roundsProcessed: result.rounds_processed,
      messagesProcessed: result.messages_processed,
      l0Recorded: result.l0_recorded,
      durationMs: result.duration_ms,
      outputDir: result.output_dir,
    };
  }
}

export function createMemoryPlatformAdapter(
  bridge: MemoryPlatformBridge,
  opts: MemoryGatewayClientOptions = {},
): MemoryPlatformAdapter {
  return new MemoryPlatformAdapter({ ...opts, bridge });
}
