export class SessionQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  private closing = false;

  run<T>(sessionKey: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (this.closing) return Promise.resolve(undefined);
    const previous = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(sessionKey, next);
    const cleanup = () => {
      if (this.queues.get(sessionKey) === next) this.queues.delete(sessionKey);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  async dispose(timeoutMs: number): Promise<"settled" | "timeout"> {
    this.closing = true;
    const pending = [...this.queues.values()];
    if (pending.length === 0) return "settled";
    const settled = Promise.all(pending.map((operation) => operation.catch(() => undefined)))
      .then(() => "settled" as const);
    if (timeoutMs <= 0) return settled;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        settled,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}