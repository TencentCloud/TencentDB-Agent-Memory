/**
 * SerialQueue: a lightweight task queue with concurrency=1.
 *
 * Equivalent to `new PQueue({ concurrency: 1 })` but with zero external
 * dependencies. Supports:
 * - Serial execution (FIFO)
 * - `add(fn)` to enqueue a task (returns the task's result promise)
 * - `onIdle()` to wait until all queued tasks have completed
 * - `pause()` / `start()` to suspend/resume execution
 * - `size` to check pending task count
 */

type Task<T = unknown> = () => Promise<T>;

interface QueueEntry {
  task: Task;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class SerialQueue {
  public readonly name: string;

  private queue: QueueEntry[] = [];
  private running = false;
  private paused = false;
  private idleResolvers: Array<() => void> = [];

  constructor(name = "unnamed") {
    this.name = name;
  }

  get size(): number {
    return this.queue.length;
  }

  get pending(): boolean {
    return this.running;
  }

  get idle(): boolean {
    return this.queue.length === 0 && !this.running;
  }

  add<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  pause(): void {
    this.paused = true;
  }

  start(): void {
    this.paused = false;
    this.drain();
  }

  onIdle(): Promise<void> {
    if (this.queue.length === 0 && !this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  clear(): void {
    for (const entry of this.queue) {
      entry.reject(new Error("Queue cleared"));
    }
    this.queue = [];
  }

  private drain(): void {
    if (this.running || this.paused || this.queue.length === 0) return;

    const entry = this.queue.shift()!;
    this.running = true;

    Promise.resolve()
      .then(() => entry.task())
      .then((result) => entry.resolve(result))
      .catch((err) => entry.reject(err))
      .finally(() => {
        this.running = false;
        if (this.queue.length === 0) {
          const resolvers = this.idleResolvers;
          this.idleResolvers = [];
          for (const resolve of resolvers) resolve();
        } else {
          this.drain();
        }
      });
  }
}
