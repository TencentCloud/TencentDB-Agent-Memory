/**
 * KeyedAsyncMutex — a per-key async mutex (one critical section at a time per key).
 *
 * ## Why this exists (persona.md single-writer)
 *
 * `persona.md` is written by two background stages that run on **separate**
 * `SerialQueue`s (`utils/pipeline-manager.ts`), so they are NOT serialized
 * against each other:
 *
 *   - **L3** `PersonaGenerator.generateLocalPersona` — a read → ~180s LLM
 *     tool-write → read-back → final write cycle.
 *   - **L2** `SceneExtractor.updateSceneNavigation` — a read → strip-nav →
 *     append-nav → write cycle.
 *
 * Both are read-modify-write. `atomicWriteFile` (temp+rename) prevents a *torn
 * read* but NOT a *lost update*: if the two interleave, whichever writes last
 * overwrites the other's body with content built from a now-stale read (e.g. an
 * L2 nav write clobbering a freshly regenerated L3 body). Routing both writers
 * through one mutex keyed by the file's absolute path makes each whole RMW
 * mutually exclusive, so neither can clobber the other.
 *
 * The L3 critical section spans the full LLM run by design ("Method B"): the LLM
 * writes `persona.md` directly mid-run, so a correct critical section must cover
 * it. The cost is that a same-account L2 nav update can wait behind an in-flight
 * persona regen — acceptable because regen is infrequent and nav is cheap and
 * deferrable. Recall *reads* `persona.md` without taking this lock, so the read
 * hot path is unaffected (atomic writes keep reads whole).
 *
 * ## Semantics
 *
 * - Keys are independent: different keys run concurrently, same key serializes.
 * - Critical sections sharing a key run strictly in call (FIFO) order.
 * - A failing critical section does NOT poison the key — the next waiter still
 *   runs, and `run` rejects only to the caller whose `fn` threw.
 * - In-process only. This relies on the "one process per dataDir" invariant
 *   (see the integration guide §9.1); it does not guard against two processes
 *   writing the same file.
 */
export class KeyedAsyncMutex {
  /** Tail of the release-chain per key. Absence === currently unlocked. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Critical sections sharing `key` run one at a time, in call order. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    // Our gate resolves when WE release; the next caller for this key waits on
    // it (chained after every earlier holder). The chain only ever resolves
    // (never rejects), so one failing section cannot block the queue.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);

    await prev; // our turn, once all earlier holders have released
    try {
      return await fn();
    } finally {
      release();
      // Drop the key once we are the last in line, so the map does not grow
      // unbounded across many one-shot keys.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Number of keys with an active or queued holder (for tests/diagnostics). */
  get activeKeys(): number {
    return this.tails.size;
  }
}

/**
 * Process-wide mutex for files written by more than one pipeline stage, keyed by
 * the file's **absolute path**. Per-account isolation is automatic because each
 * account's `persona.md` lives at a distinct path, so different accounts never
 * contend. Shared by {@link PersonaGenerator} (L3) and {@link SceneExtractor} (L2).
 */
export const fileWriteMutex = new KeyedAsyncMutex();
