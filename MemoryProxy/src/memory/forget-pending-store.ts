import { randomUUID } from "node:crypto";

export type ForgetTargetKind = "memory-prompt" | "skill";

export interface ForgetTarget {
  kind: ForgetTargetKind;
  id: string;
  name: string;
  teamId: string;
  agentId: string;
  preview: string;
  detail: string;
}

type ReadyEntry = {
  state: "ready";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
};

type ExecutingEntry = {
  state: "executing";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
  promise: Promise<void>;
};

type CompletedEntry = {
  state: "completed";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
};

type ForgetEntry = ReadyEntry | ExecutingEntry | CompletedEntry;

export interface ForgetPendingStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createId?: () => string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ForgetPendingStore {
  private readonly entries = new Map<string, ForgetEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: ForgetPendingStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  prepare(sessionKey: string, target: ForgetTarget): string {
    this.pruneExpired();
    const actionId = this.createId();
    this.entries.set(actionId, {
      state: "ready",
      sessionKey,
      target,
      expiresAt: this.now() + this.ttlMs,
    });
    return actionId;
  }

  async confirm(
    actionId: string,
    sessionKey: string,
    execute: (target: ForgetTarget) => Promise<void>,
  ): Promise<void> {
    const entry = this.getLive(actionId, sessionKey);
    if (!entry) throw new Error("forget action is missing or expired");
    if (entry.state === "completed") return;
    if (entry.state === "executing") {
      await entry.promise;
      return;
    }

    const promise = Promise.resolve()
      .then(() => execute(entry.target))
      .catch(() => {
        this.entries.delete(actionId);
        throw new Error("forget action failed; run a fresh preview");
      });
    const executing: ExecutingEntry = { ...entry, state: "executing", promise };
    this.entries.set(actionId, executing);

    await promise;
    this.entries.set(actionId, { ...executing, state: "completed" });
  }

  private getLive(actionId: string, sessionKey: string): ForgetEntry | null {
    const entry = this.entries.get(actionId);
    if (!entry || entry.sessionKey !== sessionKey) return null;
    if (this.now() >= entry.expiresAt && entry.state !== "executing") {
      this.entries.delete(actionId);
      return null;
    }
    return entry;
  }

  private pruneExpired(): void {
    const currentTime = this.now();
    for (const [actionId, entry] of this.entries) {
      if (entry.state === "executing" || currentTime < entry.expiresAt) continue;
      this.entries.delete(actionId);
    }
  }
}
