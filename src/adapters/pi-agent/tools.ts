import type { PiAgentGatewayClient } from "./gateway-client.js";
import type {
  PiAgentContextGetArgs,
  PiAgentConversationSearchArgs,
  PiAgentMemorySearchArgs,
} from "./types.js";

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(20, Math.trunc(limit!)));
}

export class PiAgentMemoryTools {
  constructor(
    private readonly client: Pick<PiAgentGatewayClient, "searchMemories" | "searchConversations">,
  ) {}

  async memorySearch(args: PiAgentMemorySearchArgs): Promise<string> {
    if (!args.query?.trim()) return "Missing required argument: query";
    const result = await this.client.searchMemories({
      query: args.query,
      limit: clampLimit(args.limit),
      type: args.type,
      scene: args.scene,
    });
    return result.results || "No matching memories found.";
  }

  async conversationSearch(args: PiAgentConversationSearchArgs): Promise<string> {
    if (!args.query?.trim()) return "Missing required argument: query";
    const result = await this.client.searchConversations({
      query: args.query,
      limit: clampLimit(args.limit),
      session_key: args.session_key ?? args.sessionKey,
    });
    return result.results || "No matching conversation messages found.";
  }

  contextGet(_args: PiAgentContextGetArgs): string {
    return "Pi Agent short-term context_get is reserved for the next stage; v1 does not persist tool trajectory context.";
  }
}