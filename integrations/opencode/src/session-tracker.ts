import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AdapterLogger } from "./types.js";

interface CaptureState {
  version: 1;
  captured: Record<string, string[]>;
}

export class SessionTracker {
  private readonly captured = new Map<string, Set<string>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly observed = new Set<string>();
  private readonly observedUsers = new Map<string, Set<string>>();
  private loadPromise?: Promise<void>;
  private writeChain = Promise.resolve();

  constructor(
    private readonly stateFile?: string,
    private readonly logger?: AdapterLogger,
  ) {}

  observe(sessionId: string): void {
    this.observed.add(sessionId);
  }

  async hasCaptured(sessionId: string, messageId: string): Promise<boolean> {
    await this.load();
    return this.captured.get(sessionId)?.has(messageId) ?? false;
  }

  async markCaptured(sessionId: string, messageId: string): Promise<void> {
    await this.load();
    let messages = this.captured.get(sessionId);
    if (!messages) {
      messages = new Set();
      this.captured.set(sessionId, messages);
    }
    messages.add(messageId);
    await this.persist();
  }

  observeUserMessage(sessionId: string, messageId: string): void {
    this.observe(sessionId);
    let messages = this.observedUsers.get(sessionId);
    if (!messages) {
      messages = new Set();
      this.observedUsers.set(sessionId, messages);
    }
    messages.add(messageId);
  }

  hasObservedUser(sessionId: string, messageId: string): boolean {
    return this.observedUsers.get(sessionId)?.has(messageId) ?? false;
  }

  serialize(sessionId: string, operation: () => Promise<void>): Promise<void> {
    this.observe(sessionId);
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.chains.set(sessionId, next);
    const cleanup = (): void => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  sessionIds(): string[] {
    return [...this.observed];
  }

  async remove(sessionId: string): Promise<void> {
    await this.load();
    this.captured.delete(sessionId);
    this.observedUsers.delete(sessionId);
    this.chains.delete(sessionId);
    this.observed.delete(sessionId);
    await this.persist();
  }

  async waitForInflight(timeoutMs = 10_000): Promise<void> {
    const pending = [...this.chains.values()];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      new Promise<void>((resolveDone) => setTimeout(resolveDone, timeoutMs)),
    ]);
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk();
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.stateFile) return;
    let raw: string;
    try {
      raw = await readFile(this.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.logger?.warn(
        `Capture state could not be read: ${this.reason(error)}`,
      );
      return;
    }

    try {
      const state = JSON.parse(raw) as Partial<CaptureState>;
      if (
        state.version !== 1 ||
        !state.captured ||
        typeof state.captured !== "object"
      ) {
        throw new Error("unsupported state format");
      }
      for (const [sessionId, messageIds] of Object.entries(state.captured)) {
        if (!Array.isArray(messageIds)) continue;
        const validIds = messageIds.filter(
          (id): id is string => typeof id === "string",
        );
        if (validIds.length > 0)
          this.captured.set(sessionId, new Set(validIds));
      }
    } catch (error) {
      this.logger?.warn(
        `Capture state is invalid and will be ignored: ${this.reason(error)}`,
      );
    }
  }

  private async persist(): Promise<void> {
    if (!this.stateFile) return;
    const snapshot: CaptureState = {
      version: 1,
      captured: Object.fromEntries(
        [...this.captured].map(([sessionId, messageIds]) => [
          sessionId,
          [...messageIds],
        ]),
      ),
    };
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.stateFile!), { recursive: true });
      const temporaryFile = `${this.stateFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryFile,
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8",
        );
        await rename(temporaryFile, this.stateFile!);
      } catch (error) {
        await rm(temporaryFile, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    const pendingWrite = this.writeChain.catch(() => undefined).then(write);
    this.writeChain = pendingWrite;
    await pendingWrite;
  }

  private reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
