import { setTimeout as delay } from "node:timers/promises";
import { PiOutboxStore, type PiOutboxRecord } from "./pi-outbox-store.js";
import type { PiDeliveryResult, PiOutboxSender } from "./pi-outbox-sender.js";

export interface PiOutboxPolicy {
  leaseMs: number;
  timeoutMs: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  batchSize: number;
}
export interface PiOutboxFlushResult {
  delivered: number;
  retried: number;
  dead: number;
  lost: number;
  errors: string[];
  unreadable: { file: string; reason: string }[];
}

/** Explicitly started by a caller; importing this module never initiates delivery. */
export class PiOutboxWorker {
  private readonly policy: PiOutboxPolicy;
  private active?: Promise<PiOutboxFlushResult>;

  constructor(private readonly store: PiOutboxStore, private readonly send: PiOutboxSender,
    policy: Partial<PiOutboxPolicy> = {}) {
    this.policy = { leaseMs: 30_000, timeoutMs: 20_000, maxAttempts: 8,
      baseRetryMs: 1_000, maxRetryMs: 300_000, batchSize: 100, ...policy };
    for (const value of Object.values(this.policy)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid outbox policy");
    }
    if (this.policy.leaseMs < 30 || this.policy.leaseMs > 86_400_000
      || this.policy.maxRetryMs > 86_400_000 || this.policy.baseRetryMs > this.policy.maxRetryMs) {
      throw new Error("Invalid outbox timing policy");
    }
  }

  /** Same-instance calls share one pass. Other processes coordinate via file leases. */
  flush(signal?: AbortSignal): Promise<PiOutboxFlushResult> {
    if (!this.active) {
      this.active = this.flushOnce(signal).finally(() => { this.active = undefined; });
    }
    return this.active;
  }

  /** Optional polling loop. Await it during shutdown; abort interrupts active delivery. */
  async run(signal: AbortSignal, onPass: (result: PiOutboxFlushResult) => void = () => {}, pollMs = 1_000): Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("Invalid polling interval");
    while (!signal.aborted) {
      onPass(await this.flush(signal));
      try { await delay(pollMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }

  private async flushOnce(signal?: AbortSignal): Promise<PiOutboxFlushResult> {
    const recovered = await this.store.recover();
    const result: PiOutboxFlushResult = { delivered: 0, retried: 0, dead: 0, lost: 0,
      errors: [], unreadable: recovered.unreadable };
    for (const record of recovered.records.slice(0, this.policy.batchSize)) {
      if (signal?.aborted) break;
      try {
        const outcome = await this.deliver(record, signal);
        if (outcome) result[outcome]++;
      } catch {
        // Leave the durable record in place for recovery; continue unrelated records.
        result.errors.push(record.id);
      }
    }
    return result;
  }

  private async deliver(record: PiOutboxRecord, signal?: AbortSignal): Promise<"delivered" | "retried" | "dead" | "lost" | null> {
    let lease = await this.store.claim(record.id, this.policy.leaseMs);
    if (!lease) return null;
    if (lease.attempts > this.policy.maxAttempts) {
      return await this.store.deadLetter(lease, "exhausted") ? "dead" : "lost";
    }
    const controller = new AbortController();
    let lost = false;
    let heartbeat: Promise<void> | undefined;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.policy.timeoutMs);
    const renewalTimer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = (async () => {
        try {
          const renewed = await this.store.renew(lease!, this.policy.leaseMs);
          if (!renewed) { lost = true; abort(); } else lease = renewed;
        } catch { lost = true; abort(); }
      })().finally(() => { heartbeat = undefined; });
    }, Math.floor(this.policy.leaseMs / 3));
    let result: PiDeliveryResult;
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<PiDeliveryResult>(resolve => {
        onAbort = () => resolve({ ok: false, retryable: true, reason: "timeout" });
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      // Race also bounds custom senders that neglect AbortSignal. Their late result
      // must never acknowledge a record subsequently acquired by another worker.
      result = await Promise.race([
        controller.signal.aborted ? aborted : this.send(lease.record, controller.signal).catch(
          (): PiDeliveryResult => ({ ok: false, retryable: true, reason: "network" }),
        ), aborted,
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(renewalTimer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
      await heartbeat;
    }
    if (lost) return "lost";
    if (result.ok) return await this.store.acknowledge(lease) ? "delivered" : "lost";
    if (!signal?.aborted && (!result.retryable || lease.attempts >= this.policy.maxAttempts)) {
      return await this.store.deadLetter(lease, result.reason) ? "dead" : "lost";
    }
    const wait = Math.min(this.policy.maxRetryMs, this.policy.baseRetryMs * 2 ** Math.min(lease.attempts - 1, 30));
    return await this.store.release(lease, wait, result.reason) ? "retried" : "lost";
  }
}
