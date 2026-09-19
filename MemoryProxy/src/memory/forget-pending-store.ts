import { randomUUID } from "node:crypto";

export type ForgetTargetKind = "memory-prompt" | "skill";

export interface ForgetTarget {
  key: string;
  kind: ForgetTargetKind;
  id: string;
  name: string;
  teamId: string;
  agentId: string;
  preview: string;
  detail: string;
  impact: string;
}

export interface ForgetExecutionResult {
  kind: ForgetTargetKind;
  name: string;
}

export type ForgetCancelState = "cancelled" | "already-completed" | "already-executing" | "missing";

type PendingEntry = {
  state: "pending";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
};

type ExecutingEntry = {
  state: "executing";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
  promise: Promise<ForgetExecutionResult>;
};

type CompletedEntry = {
  state: "completed";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
  result: ForgetExecutionResult;
};

type CancelledEntry = {
  state: "cancelled";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
};

type UncertainEntry = {
  state: "uncertain";
  sessionKey: string;
  target: ForgetTarget;
  expiresAt: number;
  error: Error;
};

type ForgetEntry = PendingEntry | ExecutingEntry | CompletedEntry | CancelledEntry | UncertainEntry;

export interface ForgetConfirmOutcome {
  result: ForgetExecutionResult;
  alreadyCompleted: boolean;
}

export interface ForgetPendingStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createId?: () => string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ForgetPendingStore {
  private readonly entries = new Map<string, ForgetEntry>();
  private readonly currentBySession = new Map<string, string>();
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
    this.expireCurrent(sessionKey);
    const previousId = this.currentBySession.get(sessionKey);
    if (previousId) this.entries.delete(previousId);

    const actionId = this.createId();
    this.entries.set(actionId, {
      state: "pending",
      sessionKey,
      target,
      expiresAt: this.now() + this.ttlMs,
    });
    this.currentBySession.set(sessionKey, actionId);
    return actionId;
  }

  getPending(actionId: string, sessionKey: string): ForgetTarget | null {
    const entry = this.getLive(actionId, sessionKey);
    return entry?.state === "pending" ? entry.target : null;
  }

  async confirm(
    actionId: string,
    sessionKey: string,
    execute: (target: ForgetTarget) => Promise<ForgetExecutionResult>,
  ): Promise<ForgetConfirmOutcome> {
    const entry = this.getLive(actionId, sessionKey);
    if (!entry) throw new Error("forget action is missing or expired");
    if (entry.state === "cancelled") throw new Error("forget action was cancelled");
    if (entry.state === "uncertain") throw new Error("forget action outcome is uncertain; run a fresh preview");
    if (entry.state === "completed") return { result: entry.result, alreadyCompleted: true };
    if (entry.state === "executing") {
      return { result: await entry.promise, alreadyCompleted: false };
    }

    const promise = execute(entry.target);
    const executing: ExecutingEntry = { ...entry, state: "executing", promise };
    this.entries.set(actionId, executing);

    try {
      const result = await promise;
      this.entries.set(actionId, { ...executing, state: "completed", result });
      return { result, alreadyCompleted: false };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.entries.set(actionId, { ...executing, state: "uncertain", error });
      throw new Error("forget action outcome is uncertain; run a fresh preview");
    }
  }

  cancel(actionId: string, sessionKey: string): ForgetCancelState {
    const entry = this.getLive(actionId, sessionKey);
    if (!entry) return "missing";
    if (entry.state === "completed") return "already-completed";
    if (entry.state === "executing" || entry.state === "uncertain") return "already-executing";
    if (entry.state === "cancelled") return "cancelled";

    this.entries.set(actionId, { ...entry, state: "cancelled" });
    return "cancelled";
  }

  private getLive(actionId: string, sessionKey: string): ForgetEntry | null {
    const entry = this.entries.get(actionId);
    if (!entry || entry.sessionKey !== sessionKey) return null;
    if (this.now() >= entry.expiresAt && entry.state !== "executing") {
      this.entries.delete(actionId);
      if (this.currentBySession.get(sessionKey) === actionId) this.currentBySession.delete(sessionKey);
      return null;
    }
    return entry;
  }

  private expireCurrent(sessionKey: string): void {
    const actionId = this.currentBySession.get(sessionKey);
    if (actionId) this.getLive(actionId, sessionKey);
  }

  private pruneExpired(): void {
    const currentTime = this.now();
    for (const [actionId, entry] of this.entries) {
      if (entry.state === "executing" || currentTime < entry.expiresAt) continue;
      this.entries.delete(actionId);
      if (this.currentBySession.get(entry.sessionKey) === actionId) {
        this.currentBySession.delete(entry.sessionKey);
      }
    }
  }
}
