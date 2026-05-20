/**
 * SerialQueue: a lightweight FIFO task queue.
 *
 * Equivalent to `new PQueue({ concurrency })` but with zero external
 * dependencies. Supports:
 * - FIFO execution with bounded concurrency
 * - `add(fn)` to enqueue a task (returns the task's result promise)
 * - `onIdle()` to wait until all queued tasks have completed
 * - `pause()` / `start()` to suspend/resume execution
 * - `size` to check pending task count
 * - Optional debug logger for enqueue/dequeue/complete diagnostics
 */

type Task<T = unknown> = () => Promise<T>;

interface QueueEntry {
  task: Task;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class SerialQueue {
  /** Human-readable name for logging / diagnostics. */
  public readonly name: string;
  public readonly concurrency: number;

  private queue: QueueEntry[] = [];
  private runningCount = 0;
  private paused = false;
  private idleResolvers: Array<() => void> = [];

  /** Optional debug logger — receives diagnostic messages for enqueue/dequeue/complete. */
  private debugFn?: (msg: string) => void;

  constructor(name = "unnamed", concurrency = 1) {
    this.name = name;
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  /** Set a debug logger for queue diagnostics. */
  setDebugLogger(fn: (msg: string) => void): void {
    this.debugFn = fn;
  }

  /** Number of tasks waiting to be executed. */
  get size(): number {
    return this.queue.length;
  }

  /** Whether a task is currently executing. */
  get pending(): boolean {
    return this.runningCount > 0;
  }

  /** Whether the queue is idle (no queued tasks and nothing running). */
  get idle(): boolean {
    return this.queue.length === 0 && this.runningCount === 0;
  }

  /** Add a task to the queue. Returns the task's result promise. */
  add<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.debugFn?.(
        `[queue:${this.name}] enqueued, pending=${this.queue.length}, ` +
        `running=${this.runningCount}/${this.concurrency}`,
      );
      this.drain();
    });
  }

  /** Pause the queue. Currently running task will finish, but no new tasks start. */
  pause(): void {
    this.paused = true;
  }

  /** Resume the queue after pause(). */
  start(): void {
    this.paused = false;
    this.drain();
  }

  /** Returns a promise that resolves when all queued tasks have completed. */
  onIdle(): Promise<void> {
    if (this.queue.length === 0 && this.runningCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  /** Clear all pending (not yet started) tasks. */
  clear(): void {
    for (const entry of this.queue) {
      entry.reject(new Error("Queue cleared"));
    }
    this.queue = [];
  }

  private drain(): void {
    while (!this.paused && this.runningCount < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.runningCount++;

      this.debugFn?.(
        `[queue:${this.name}] dequeued, starting execution ` +
        `(remaining=${this.queue.length}, running=${this.runningCount}/${this.concurrency})`,
      );

      void (async () => {
        let result: unknown;
        let error: unknown;
        let failed = false;
        try {
          result = await entry.task();
        } catch (err) {
          error = err;
          failed = true;
        } finally {
          this.runningCount--;
          this.debugFn?.(
            `[queue:${this.name}] task completed ` +
            `(remaining=${this.queue.length}, running=${this.runningCount}/${this.concurrency})`,
          );
          if (this.queue.length === 0 && this.runningCount === 0) {
            // Notify idle waiters
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const resolve of resolvers) resolve();
          } else {
            this.drain();
          }
        }

        if (failed) {
          entry.reject(error);
        } else {
          entry.resolve(result);
        }
      })();
    }
  }
}
