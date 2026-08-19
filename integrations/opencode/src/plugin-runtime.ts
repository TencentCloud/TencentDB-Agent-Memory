import {
  collectCompletedTurns,
  extractText,
  formatRecallInjection,
} from "./message-codec.js";
import type { MemoryService } from "./memory-service.js";
import type { ResultFormatter } from "./result-formatter.js";
import type { SessionResolver } from "./session-resolver.js";
import type { SessionTracker } from "./session-tracker.js";
import type {
  AdapterLogger,
  OpenCodeAdapterConfig,
  OpenCodeMessageWithParts,
  OpenCodePart,
} from "./types.js";

interface SessionClient {
  session: {
    messages(input: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data?: unknown; error?: unknown }>;
  };
}

export class OpenCodeMemoryRuntime {
  private disposed = false;

  constructor(
    private readonly config: OpenCodeAdapterConfig,
    private readonly client: SessionClient,
    private readonly directory: string,
    private readonly service: MemoryService,
    private readonly sessions: SessionResolver,
    private readonly tracker: SessionTracker,
    readonly formatter: ResultFormatter,
    private readonly logger: AdapterLogger,
  ) {}

  async recallForMessage(
    sessionId: string,
    messageId: string,
    parts: OpenCodePart[],
  ): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const query = extractText(parts);
    if (!query) return undefined;
    this.tracker.observeUserMessage(sessionId, messageId);

    try {
      const result = await this.service.run(() =>
        this.service.client.recall({
          query,
          session_key: this.sessions.resolve(sessionId),
          user_id: this.config.userId,
        }),
      );
      if (!result.context?.trim()) return undefined;
      const wrapperChars = formatRecallInjection("").length;
      return formatRecallInjection(
        this.formatter.limit(result.context, wrapperChars),
      );
    } catch (error) {
      this.logger.warn(`Automatic recall skipped: ${this.reason(error)}`);
      return undefined;
    }
  }

  captureSession(sessionId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.tracker.serialize(sessionId, () =>
      this.captureSessionUnlocked(sessionId),
    );
  }

  async endSession(sessionId: string, remove = false): Promise<void> {
    if (this.disposed) return;
    await this.tracker.serialize(sessionId, async () => {
      await this.captureSessionUnlocked(sessionId);
      try {
        await this.service.run(() =>
          this.service.client.sessionEnd({
            session_key: this.sessions.resolve(sessionId),
            user_id: this.config.userId,
          }),
        );
      } catch (error) {
        this.logger.warn(`Session flush skipped: ${this.reason(error)}`);
      }
    });
    if (remove) await this.tracker.remove(sessionId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.tracker.waitForInflight();
    for (const sessionId of this.tracker.sessionIds()) {
      await this.endSession(sessionId);
    }
    this.disposed = true;
  }

  resolveSession(sessionId?: string, explicit?: string): string {
    return this.sessions.resolve(sessionId, explicit);
  }

  userId(explicit?: string): string {
    return explicit?.trim() || this.config.userId;
  }

  private async captureSessionUnlocked(sessionId: string): Promise<void> {
    let messages: OpenCodeMessageWithParts[];
    try {
      messages = await this.readMessages(sessionId);
    } catch (error) {
      this.logger.warn(
        `Automatic capture could not read session ${sessionId}: ${this.reason(error)}`,
      );
      return;
    }

    for (const turn of collectCompletedTurns(messages)) {
      if (!this.tracker.hasObservedUser(sessionId, turn.userMessageId))
        continue;
      if (await this.tracker.hasCaptured(sessionId, turn.assistantMessageId))
        continue;
      try {
        await this.service.run(() =>
          this.service.client.capture({
            user_content: turn.userText,
            assistant_content: turn.assistantText,
            session_key: this.sessions.resolve(sessionId),
            session_id: sessionId,
            user_id: this.config.userId,
            messages: turn.messages,
          }),
        );
        await this.tracker.markCaptured(sessionId, turn.assistantMessageId);
      } catch (error) {
        this.logger.warn(`Automatic capture skipped: ${this.reason(error)}`);
        return;
      }
    }
  }

  private async readMessages(
    sessionId: string,
  ): Promise<OpenCodeMessageWithParts[]> {
    const response = await this.client.session.messages({
      path: { id: sessionId },
      query: { directory: this.directory },
    });
    if (response.error)
      throw new Error("OpenCode SDK returned a session message error.");
    if (!Array.isArray(response.data)) return [];
    return response.data as OpenCodeMessageWithParts[];
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
