import { GatewayMemoryClient } from "./client.js";
import type {
  GatewayPlatformAdapter,
  PlatformBinding,
} from "./types.js";

export function createGatewayPlatformAdapter<
  TPromptEvent,
  TTurnEvent,
  TSessionEvent,
  TRecallOutput,
>(
  binding: PlatformBinding<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput>,
  client: GatewayMemoryClient,
): GatewayPlatformAdapter<TPromptEvent, TTurnEvent, TSessionEvent, TRecallOutput> {
  return {
    client,

    async beforePrompt(event) {
      const identity = binding.getSessionIdentity(event);
      const response = await client.recall({
        query: binding.getRecallQuery(event),
        sessionKey: identity.sessionKey,
        userId: identity.userId,
      });
      return binding.formatRecall(response, event);
    },

    async turnCommitted(event) {
      const turn = binding.getCompletedTurn(event);
      if (!turn) return null;
      const identity = binding.getSessionIdentity(event);
      return client.capture({
        ...turn,
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        userId: identity.userId,
      });
    },

    async sessionEnd(event) {
      const identity = binding.getSessionIdentity(event);
      return client.endSession({
        sessionKey: identity.sessionKey,
        userId: identity.userId,
      });
    },
  };
}
