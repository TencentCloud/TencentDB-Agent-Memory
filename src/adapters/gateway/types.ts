/**
 * Platform-neutral memory capability contract.
 *
 * Protocol adapters such as MCP depend on this interface rather than on
 * TdaiCore or a concrete transport. A direct in-process adapter and the HTTP
 * Gateway client can therefore expose the same capabilities.
 */

export interface HealthResult {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

export interface RecallInput {
  query: string;
  sessionKey: string;
  userId?: string;
}

export interface RecallOutput {
  context: string;
  strategy?: string;
  memoryCount?: number;
}

export interface CaptureInput {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  messages?: unknown[];
}

export interface CaptureOutput {
  l0Recorded: number;
  schedulerNotified: boolean;
}

export interface MemorySearchInput {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface MemorySearchOutput {
  results: string;
  total: number;
  strategy: string;
}

export interface ConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface ConversationSearchOutput {
  results: string;
  total: number;
}

export interface EndSessionInput {
  sessionKey: string;
  userId?: string;
}

export interface EndSessionOutput {
  flushed: boolean;
}

/**
 * The complete public capability surface required by a platform adapter.
 */
export interface MemoryService {
  health(): Promise<HealthResult>;
  recall(input: RecallInput): Promise<RecallOutput>;
  capture(input: CaptureInput): Promise<CaptureOutput>;
  searchMemories(input: MemorySearchInput): Promise<MemorySearchOutput>;
  searchConversations(input: ConversationSearchInput): Promise<ConversationSearchOutput>;
  endSession(input: EndSessionInput): Promise<EndSessionOutput>;
}
