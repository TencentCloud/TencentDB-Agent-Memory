/**
 * The one port every memory mutation reports through (tz-03b).
 *
 * A port, not a bus: there is exactly one observer slot and one subscriber
 * today — the layer counters, which recompute from the store rather than
 * counting events (tz-03 §B6). Provenance (tz-05) will take the same slot by
 * composing with the counter observer, not by growing a subscriber list.
 *
 * `affected` is for the log line, never for arithmetic. A counter that added
 * up `affected` would be the increment counter this package exists to remove.
 */
export type MemoryCarrier = "l1" | "scene";

export interface MemoryMutation {
  carrier: MemoryCarrier;
  kind: "upsert" | "delete" | "update";
  /** Rows/files touched — diagnostic only. */
  affected: number;
  /** Who mutated: "apply" | "write-memory" | "cleaner" | "feedback" | … */
  source: string;
  at: string;
}

export interface MemoryCommitObserver {
  onCommitted(m: MemoryMutation): void | Promise<void>;
}

export interface CommitPortLogger {
  warn?: (msg: string) => void;
}

let observer: MemoryCommitObserver | undefined;
let logger: CommitPortLogger | undefined;

/** Install the observer (or clear it with `undefined`). Without one the port
 * is a no-op, which is also the rollback path for this whole package. */
export function setCommitObserver(
  next: MemoryCommitObserver | undefined,
  log?: CommitPortLogger,
): void {
  observer = next;
  logger = log;
}

/**
 * Announce a mutation that ALREADY happened. Never throws and never awaits:
 * a failing observer must not undo an applied mutation (tz-03 НФТ), and a
 * mutation path must not wait on bookkeeping. The discrepancy surfaces
 * instead in memory_health.md, which prints the stored counter against a live
 * recount — a silent failure here becomes a visible drift there.
 */
export function notifyCommitted(m: MemoryMutation): void {
  if (observer === undefined) return;
  try {
    const result = observer.onCommitted(m);
    if (result instanceof Promise) {
      result.catch((err: unknown) => report(m, err));
    }
  } catch (err) {
    report(m, err);
  }
}

function report(m: MemoryMutation, err: unknown): void {
  logger?.warn?.(
    `[commit-port] observer failed for ${m.carrier}/${m.kind} from ${m.source}: ` +
      `${err instanceof Error ? err.message : String(err)} — mutation stands, counters may drift`,
  );
}
