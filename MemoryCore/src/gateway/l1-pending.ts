/**
 * Pending-L0 inspection helper for the gateway executor's dedup guard.
 *
 * Context (2026-09-17 incident): `executeL1` used to skip timer-fired L1 tasks
 * whenever `conversation_count === 0`. That counter is not a reliable "nothing
 * pending" signal — a completing L1 resets it to zero while a fresh capture
 * lands concurrently, wiping that round's increment. The skipped task then
 * left real L0 rows past the cursor, and because the idle timer is consumed
 * and never re-arms without new captures, the backlog stranded indefinitely
 * ("2 轮未蒸馏" forever, no L1 output).
 *
 * Fix invariant: a timer-fired L1 may only be skipped when the L0 store
 * confirms there are ZERO rows after the session's cursor. This helper is
 * that confirmation.
 */
import type { IMemoryStore } from "../core/store/types.js";

/**
 * Count L0 rows for `sessionKey` recorded after `cursorOrUndefined`
 * (epoch-ms `recorded_at` semantics, matching `last_l1_cursor`). Pass
 * `undefined` when the session has never been distilled (cursor 0).
 *
 * `limit` defaults to 1 — callers only need presence/absence; the newest
 * `limit` rows are inspected, which is exactly the pending tail.
 *
 * The store is asked to `throwOnError`: sqlite/tcvdb normally swallow query
 * failures into `[]`, and an error read as "zero pending" here would skip the
 * timer-fired L1 and strand the backlog — the exact failure this guard exists
 * to prevent. A failed query therefore rejects instead of returning 0.
 */
export async function countPendingL0Rows(
  store: Pick<IMemoryStore, "queryL0GroupedBySessionId">,
  sessionKey: string,
  cursorOrUndefined: number | undefined,
  limit = 1,
): Promise<number> {
  const groups = await store.queryL0GroupedBySessionId(sessionKey, cursorOrUndefined, limit, {
    throwOnError: true,
  });
  let total = 0;
  for (const g of groups) {
    total += g.messages?.length ?? 0;
  }
  return total;
}
