/**
 * BuildQueue — per-asset-key serial execution queue.
 *
 * Each asset id gets its own SerialQueue → same asset never rebuilds
 * concurrently (git/SQLite/files don't conflict).
 * enqueue is fire-and-forget; onIdle() for tests / graceful shutdown.
 */

import { SerialQueue } from "./serial-queue.js";

export class BuildQueue {
  private readonly queues = new Map<string, SerialQueue>();
  private readonly cleanupScheduled = new WeakSet<SerialQueue>();

  /** Enqueue job to this key's serial queue; fire-and-forget. */
  enqueue(key: string, job: () => Promise<void>): void {
    let q = this.queues.get(key);
    if (!q) {
      q = new SerialQueue(key);
      this.queues.set(key, q);
    }
    const queue = q;
    const cleanup = () => {
      this.scheduleRemoval(key, queue);
    };
    void queue.add(job).then(cleanup, cleanup);
  }

  /** Wait for a key (or all) queue to be idle. Mainly for tests / shutdown. */
  async onIdle(key?: string): Promise<void> {
    if (key) {
      await this.queues.get(key)?.onIdle();
      return;
    }
    await Promise.all([...this.queues.values()].map((q) => q.onIdle()));
  }

  private scheduleRemoval(key: string, queue: SerialQueue): void {
    if (this.cleanupScheduled.has(queue)) return;
    this.cleanupScheduled.add(queue);
    void this.removeWhenIdle(key, queue);
  }

  private async removeWhenIdle(key: string, queue: SerialQueue): Promise<void> {
    try {
      await queue.onIdle();
      if (queue.idle && this.queues.get(key) === queue) {
        this.queues.delete(key);
      }
    } finally {
      this.cleanupScheduled.delete(queue);
    }
  }
}
