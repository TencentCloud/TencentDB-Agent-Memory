/**
 * Per-key FIFO mutex (in-process).
 *
 * `run(key, fn)` executes `fn` only after every earlier `run` on the same key
 * has settled; different keys never wait on each other. A rejected `fn` still
 * releases the key. Idle keys are dropped, so the map is bounded by the number
 * of keys with work in flight.
 */
export type KeyedMutex = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
