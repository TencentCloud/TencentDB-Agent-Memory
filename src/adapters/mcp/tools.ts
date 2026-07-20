import { MemoryGatewayClient, type MemoryGatewayOptions } from "./gateway.js";

export interface RecallInput {
  query: string;
  sessionKey: string;
}

export interface CaptureInput {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  messages?: unknown[];
}

export interface EndSessionInput {
  sessionKey: string;
}

export interface SearchMemoriesInput {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface SearchConversationsInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export function createMemoryTools(options: MemoryGatewayOptions = {}) {
  const gateway = new MemoryGatewayClient(options);

  return {
    async recall(input: RecallInput) {
      const response = await gateway.post<{
        context?: string;
        strategy?: string;
        memory_count?: number;
      }>("/recall", {
        query: input.query,
        session_key: input.sessionKey,
      });
      return {
        context: response.context ?? "",
        strategy: response.strategy,
        memoryCount: response.memory_count ?? 0,
      };
    },

    async capture(input: CaptureInput) {
      const response = await gateway.post<{
        l0_recorded: number;
        scheduler_notified: boolean;
      }>("/capture", {
        user_content: input.userContent,
        assistant_content: input.assistantContent,
        session_key: input.sessionKey,
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        messages: input.messages ?? [
          { role: "user", content: input.userContent },
          { role: "assistant", content: input.assistantContent },
        ],
      });
      return {
        l0Recorded: response.l0_recorded,
        schedulerNotified: response.scheduler_notified,
      };
    },

    async endSession(input: EndSessionInput) {
      return gateway.post<{ flushed: boolean }>("/session/end", {
        session_key: input.sessionKey,
      });
    },

    async searchMemories(input: SearchMemoriesInput) {
      return gateway.post<{ results: string; total: number; strategy: string }>("/search/memories", {
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.scene ? { scene: input.scene } : {}),
      });
    },

    async searchConversations(input: SearchConversationsInput) {
      return gateway.post<{ results: string; total: number }>("/search/conversations", {
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
      });
    },
  };
}

export type MemoryTools = ReturnType<typeof createMemoryTools>;