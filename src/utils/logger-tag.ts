/**
 * Logger decorator: prefix every line with a tag.
 *
 * A run's log lines are scattered across strategies, the checkpoint gate and
 * the apply executor, and only 2 of 46 call sites ever printed the run id —
 * so a line in `gateway-dev.log` could not be attributed to a run. Tagging
 * the logger ONCE, where the run id is known, gives every downstream line the
 * same prefix without touching those call sites.
 *
 * Pure: no IO of its own, it only wraps the sink it is given.
 */
import type { Logger } from "../core/types.js";

/**
 * Wrap `base` so every message is emitted as `<tag> <msg>`.
 *
 * `debug` stays undefined when the base has none: a logger with debug off
 * must not start emitting debug lines just because it was tagged.
 */
export function taggedLogger(base: Logger, tag: string): Logger {
  const debug = base.debug;
  return {
    debug: debug ? (msg: string) => debug(`${tag} ${msg}`) : undefined,
    info: (msg: string) => base.info(`${tag} ${msg}`),
    warn: (msg: string) => base.warn(`${tag} ${msg}`),
    error: (msg: string) => base.error(`${tag} ${msg}`),
  };
}

/** The tag a run's lines carry: short id, greppable, stable across modules. */
export function runTag(runId: string): string {
  return `[run:${runId.slice(0, 8)}]`;
}
