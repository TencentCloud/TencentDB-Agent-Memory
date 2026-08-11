/**
 * Layer counters as a derivative of fact (tz-03b, ТЗ A2/F3).
 *
 * Nothing here adds or subtracts: every write recomputes both carriers from
 * the store and the filesystem. That is what lets the counter FALL — after a
 * TTL sweep, after a scene soft-delete — and what makes a repeated run after a
 * crash a no-op instead of a double count.
 *
 * Both carriers are recomputed on every event regardless of which one moved.
 * Recomputing only the announced carrier would be cheaper and would silently
 * reintroduce drift: an apply that deletes L1 rows AND rewrites scenes arrives
 * as one mutation, and the other carrier would keep a stale number.
 *
 * L1 is counted through `store.countL1()`, never with SQL against
 * `l1_records`: the TCVDB backend has no such table, and SQL-only counting is
 * exactly the `backend-parity` violation the package forbids.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { sceneBlocksRoot } from "../../core/scene/scene-paths.js";
import { ConsolidationCheckpoint } from "./checkpoint.js";
import type {
  MemoryCommitObserver,
  MemoryMutation,
} from "../../core/record/commit-port.js";

/** The slice of the store the counters need — keeps the port testable. */
export interface CountableStore {
  countL1(): number | Promise<number>;
}

export interface CounterLogger {
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

/** L1 rows in the store, whichever backend it is. */
export async function countL1(store: CountableStore): Promise<number> {
  return await store.countL1();
}

/**
 * Scene block files under `scene_blocks/`: one level of per-project slugs plus
 * the legacy flat blocks written before the layout existed (scene-paths.ts:12).
 * The count is of the CARRIER's files — legacy blocks are no longer read, but
 * they are still on disk, and a counter that ignored them would disagree with
 * `ls` on the first legacy install.
 */
export async function countScenes(dataDir: string): Promise<number> {
  const root = sceneBlocksRoot(dataDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0; // no scenes yet — not an error
  }
  let total = 0;
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) {
      total += 1; // legacy flat block
      continue;
    }
    if (!e.isDirectory()) continue;
    try {
      const blocks = await fs.readdir(path.join(root, e.name));
      total += blocks.filter((b) => b.endsWith(".md")).length;
    } catch {
      // slug directory vanished mid-scan — it contributes nothing
    }
  }
  return total;
}

/**
 * Recompute both counters from fact and store them in the checkpoint.
 *
 * `store` may be absent: a degraded gateway (store init failed) still serves
 * the mutating routes, so the scene counter — a filesystem carrier that needs
 * no backend — must keep working, and l1Count keeps its previous value instead
 * of being overwritten with a lie.
 */
export async function recomputeCounters(
  dataDir: string,
  store: CountableStore | undefined,
): Promise<{ l1Count: number | undefined; sceneCount: number }> {
  const l1 = store === undefined ? undefined : await countL1(store);
  const scenes = await countScenes(dataDir);
  // The same locked update tz-03a uses for the cursor: the hard-link lock
  // keeps other processes out, so a concurrent finalization cannot lose this
  // write (ТЗ criterion 3a).
  await new ConsolidationCheckpoint(dataDir).update((d) => {
    if (l1 !== undefined) d.l1Count = l1;
    d.sceneCount = scenes;
  });
  return { l1Count: l1, sceneCount: scenes };
}

/**
 * The package's only commit observer. Installed once at gateway wiring;
 * removing it turns the port back into a no-op, which is both the rollback
 * path and the falsification the spec asks for (S5).
 */
export function createCounterObserver(
  dataDir: string,
  store: CountableStore | (() => CountableStore | undefined),
  logger?: CounterLogger,
): MemoryCommitObserver {
  // A supplier, not a snapshot: the gateway subscribes at start(), and the
  // store may be missing then (degraded init) or replaced later. Capturing it
  // once would silently stop the counters for the life of the process.
  const resolve =
    typeof store === "function" ? store : (): CountableStore => store;
  return {
    async onCommitted(m: MemoryMutation): Promise<void> {
      const counts = await recomputeCounters(dataDir, resolve());
      logger?.debug?.(
        `[counters] ${m.source} ${m.kind} ${m.carrier} (${m.affected}) → ` +
          `l1=${counts.l1Count ?? "(no store)"} scenes=${counts.sceneCount}`,
      );
    },
  };
}
