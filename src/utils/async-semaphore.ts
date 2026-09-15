/**
 * AsyncSemaphore — a small counting semaphore for bounding async concurrency.
 *
 * ## Why this exists (multi-tenant extraction cap)
 *
 * In the structural multi-tenant route (see `gateway/core-registry.ts`) every
 * account gets its **own** {@link MemoryPipelineManager}, each with its own L1/L2/L3
 * `SerialQueue`s. A single account is therefore naturally capped (one L1, one L2,
 * one L3 at a time), but `N` resident accounts fan out to up to `~3N`
 * **concurrent background LLM extraction calls** with nothing holding them back —
 * the real cost red line called out in design §8.4 #5.
 *
 * The fix is one semaphore *shared across all cores*: each pipeline manager runs
 * its L1/L2/L3 runner through {@link run}, so the total number of in-flight
 * extraction runs across every tenant can never exceed the configured limit.
 *
 * ## Semantics
 *
 * - `limit <= 0` (or non-finite) means **unlimited** — {@link acquire}/{@link run}
 *   resolve immediately and impose no ordering. This is the single-tenant default
 *   (one core can't fan out, so there is nothing to cap) and keeps legacy
 *   behaviour byte-for-byte.
 * - Waiters are served strictly FIFO.
 * - A permit is **handed directly** from a releaser to the next waiter without
 *   ever dropping `active` below the in-use count, so a synchronous `acquire()`
 *   racing in between a release and the woken waiter cannot over-subscribe the
 *   limit. (The naive "decrement then resolve" implementation has exactly that
 *   bug, because resolving a promise only schedules a microtask.)
 */

/** Minimal interface the pipeline manager depends on (keeps it test-friendly). */
export interface ConcurrencyLimiter {
  /** Run `fn` once a permit is available, releasing the permit when it settles. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** A limiter that imposes no bound — used when concurrency capping is disabled. */
export const PASSTHROUGH_LIMITER: ConcurrencyLimiter = {
  run: (fn) => fn(),
};

const NOOP_RELEASE = (): void => {};

export class AsyncSemaphore implements ConcurrencyLimiter {
  /** Configured permit count; `<= 0` means unlimited. */
  private readonly limit: number;
  /** Permits currently held (acquired but not yet released). */
  private inUse = 0;
  /** FIFO queue of resolvers for callers waiting on a permit. */
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  /** Whether this semaphore imposes no bound. */
  get unlimited(): boolean {
    return this.limit <= 0;
  }

  /** Configured permit count (0 = unlimited). */
  get capacity(): number {
    return this.limit;
  }

  /** Permits currently held. */
  get active(): number {
    return this.inUse;
  }

  /** Callers currently blocked waiting for a permit. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Free permits right now (`Infinity` when unlimited). */
  get available(): number {
    return this.unlimited ? Infinity : Math.max(0, this.limit - this.inUse);
  }

  /**
   * Acquire a permit, resolving with an idempotent `release` function. Always
   * call `release()` exactly once (a `try/finally` is safest — or use
   * {@link run}, which does it for you).
   */
  async acquire(): Promise<() => void> {
    if (this.unlimited) return NOOP_RELEASE;

    if (this.inUse < this.limit) {
      this.inUse++;
      return this.makeRelease();
    }

    // At capacity: wait for a permit to be handed to us. The handoff in
    // makeRelease() leaves `inUse` unchanged, so we must NOT increment here.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.makeRelease();
  }

  /** Acquire a permit, run `fn`, and release the permit when it settles. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.unlimited) return fn();
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Hand the permit straight to the next waiter: `inUse` stays the same,
        // closing the window where a racing acquire() could over-subscribe.
        next();
      } else {
        this.inUse--;
      }
    };
  }
}
