import type { RunningHandle } from "../consolidation/launchers/types.js";

const poll = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/** Drains complete L1 scheduler operations while actively cancelling children. */
export class L1OperationTracker {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly handles = new Map<string, RunningHandle>();
  private isStopping = false;
  private stopPromise: Promise<void> | null = null;

  tryRun<T>(operation: () => Promise<T>): Promise<T> | null {
    if (this.isStopping) return null;
    const running = Promise.resolve().then(operation);
    this.operations.add(running);
    void running.then(
      () => this.operations.delete(running),
      () => this.operations.delete(running),
    );
    return running;
  }

  handleStarted(attemptId: string, handle: RunningHandle): void {
    this.handles.set(attemptId, handle);
  }

  handleSettled(attemptId: string): void {
    this.handles.delete(attemptId);
  }

  stop(): Promise<void> {
    this.isStopping = true;
    this.stopPromise ??= this.drain();
    return this.stopPromise;
  }

  private async drain(): Promise<void> {
    while (this.operations.size > 0 || this.handles.size > 0) {
      await Promise.allSettled(
        [...this.handles.values()].map((handle) => handle.cancelAndWait()),
      );
      if (this.operations.size > 0) {
        await Promise.race([
          Promise.allSettled([...this.operations]),
          poll(),
        ]);
      }
    }
  }
}
