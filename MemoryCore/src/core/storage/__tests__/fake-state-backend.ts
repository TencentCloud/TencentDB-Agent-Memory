/**
 * Minimal in-memory IStateBackend test double — only the Lock section is
 * functional (mirrors LocalStateBackend's actual semantics: ownerId + TTL).
 * Everything else throws if called, since GitStorageBackend only ever uses
 * acquireLock/renewLock/releaseLock.
 */
import type {
  CaptureAtomicResult,
  IStateBackend,
  PipelineSessionState,
  TaskPayload,
  TimerEntry,
} from "../../state/types.js";

interface LockEntry {
  ownerId: string;
  expireAt: number;
}

export class FakeStateBackend implements IStateBackend {
  private locks = new Map<string, LockEntry>();
  /** Test hook: the next renewLock call for this key returns false once. */
  public forceRenewalFailureOnce = new Set<string>();

  async acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(key);
    const now = Date.now();
    if (existing && existing.expireAt > now && existing.ownerId !== ownerId) return false;
    this.locks.set(key, { ownerId, expireAt: now + ttlMs });
    return true;
  }

  async renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    if (this.forceRenewalFailureOnce.delete(key)) return false;
    const existing = this.locks.get(key);
    if (!existing || existing.ownerId !== ownerId) return false;
    existing.expireAt = Date.now() + ttlMs;
    return true;
  }

  async releaseLock(key: string, ownerId: string): Promise<void> {
    const existing = this.locks.get(key);
    if (existing && existing.ownerId === ownerId) this.locks.delete(key);
  }

  async appendBuffer(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async drainBuffer(): Promise<string[]> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async getBufferLength(): Promise<number> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async getSessionState(): Promise<PipelineSessionState | null> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async updateSessionState(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async deleteSessionState(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async listActiveSessions(): Promise<string[]> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async setTimer(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async setTimerIfEarlier(): Promise<boolean> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async removeTimer(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async getExpiredTimers(): Promise<TimerEntry[]> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async enqueueTask(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async consumeTask(): Promise<TaskPayload | null> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async ackTask(): Promise<void> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async getQueueDepth(): Promise<{ high: number; low: number }> {
    throw new Error("FakeStateBackend: not implemented");
  }
  async captureAtomic(): Promise<CaptureAtomicResult> {
    throw new Error("FakeStateBackend: not implemented");
  }
}
