import type { PiAgentGatewayClient } from "./gateway-client.js";
import { formatPiAgentMemoryContext } from "./context.js";
import { derivePiAgentSessionKey } from "./session-key.js";
import {
  getPiQuery,
  getPiSessionId,
  getPiUserId,
  getPiWorkspace,
  normalizePiMessages,
  piMessagesToSeedConversations,
} from "./mapper.js";
import type {
  PiAgentAdapterConfig,
  PiAgentBeforeAgentStartEvent,
  PiAgentBeforeAgentStartResult,
  PiAgentContextInjection,
  PiAgentContextInjector,
  PiAgentExtensionContext,
  PiAgentSessionEndResult,
  PiAgentSessionEvent,
} from "./types.js";

export class PiAgentLifecycleAdapter {
  constructor(
    private readonly client: Pick<PiAgentGatewayClient, "recall" | "seed" | "sessionEnd">,
    private readonly config: PiAgentAdapterConfig,
    private readonly injectContext?: PiAgentContextInjector,
  ) {}

  deriveSessionKey(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext): string {
    return derivePiAgentSessionKey({
      workspace: getPiWorkspace(event, ctx),
      sessionId: getPiSessionId(event, ctx),
      userId: getPiUserId(event) ?? this.config.defaultUserId,
    });
  }

  async onBeforeAgentStart(
    event: PiAgentBeforeAgentStartEvent,
    ctx?: PiAgentExtensionContext,
  ): Promise<PiAgentBeforeAgentStartResult | undefined> {
    if (!this.config.autoRecall) return undefined;

    const query = getPiQuery(event) || "Restore relevant project and user memory for this Pi Agent session.";
    const sessionKey = this.deriveSessionKey(event, ctx);
    const recall = await this.client.recall({
      query,
      session_key: sessionKey,
      user_id: getPiUserId(event) ?? this.config.defaultUserId,
    });
    const context = formatPiAgentMemoryContext({ recall, maxChars: this.config.recallMaxChars });
    if (!context) return undefined;

    const injection: PiAgentContextInjection = {
      context,
      sessionKey,
      source: "tencentdb-agent-memory",
    };
    await this.injectContext?.(injection, event, ctx);

    return {
      message: {
        customType: "tencentdb-agent-memory",
        content: context,
        display: true,
        details: {
          sessionKey,
          source: "tencentdb-agent-memory",
        },
      },
    };
  }

  async onSessionShutdown(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext): Promise<PiAgentSessionEndResult> {
    if (!this.config.autoCapture) return { captured: false, skippedReason: "auto capture disabled" };

    const messages = normalizePiMessages(event, ctx);
    const conversations = piMessagesToSeedConversations(messages);
    if (conversations.length === 0) {
      return { captured: false, skippedReason: "no complete user/assistant turns" };
    }

    const sessionKey = this.deriveSessionKey(event, ctx);
    const seed = await this.client.seed({
      session_key: sessionKey,
      strict_round_role: false,
      auto_fill_timestamps: true,
      data: {
        sessions: [{
          sessionKey,
          sessionId: getPiSessionId(event, ctx),
          conversations,
        }],
      },
    });
    await this.client.sessionEnd({
      session_key: sessionKey,
      user_id: getPiUserId(event) ?? this.config.defaultUserId,
    });

    return {
      captured: true,
      l0Recorded: seed.l0_recorded,
    };
  }

  /** Backward-compatible alias for earlier draft integrations. */
  onSessionStart(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext) {
    return this.onBeforeAgentStart(event, ctx);
  }

  /** Backward-compatible alias for earlier draft integrations. */
  onSessionEnd(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext) {
    return this.onSessionShutdown(event, ctx);
  }
}