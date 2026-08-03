/**
 * MemoryPipelineManager (Group C decomp — Group-C shim).
 *
 * The implementation now lives in `./pipeline/`:
 *   - `types.ts`         — interfaces, runner types, shared TAG
 *   - `manager.ts`       — class shell, setters, start, public accessors
 *   - `shutdown.ts`-equivalent helpers live inline in manager.ts:
 *                          `flushSession`, `destroy`, `_doFlush`
 *   - `l1.ts`            — notifyConversation, onL1IdleTimeout, enqueueL1, runL1
 *   - `timers.ts`        — L2/L3 timer scheduling, queue dispatch
 *   - `session-state.ts` — getOrCreate*, persist, gc, threshold/warmup
 *   - `recovery.ts`      — recoverPendingSessions
 *
 * This file is a re-export shim to preserve the public import path
 * (`from "./pipeline-manager.js"`) used by `auto-capture`, `tdai-core`,
 * `seed-runtime`, and the test suite.
 *
 * ## Original L0→L3 docs (preserved for grep-ability)
 *
 * MemoryPipelineManager: manages the L0→L1→L2→L3 memory extraction pipeline.
 *
 * - **L0 (capture)**: `auto-capture.ts` extracts new messages from each
 *   `agent_end` event, sanitizes them, and passes them to the pipeline via
 *   `notifyConversation(sessionKey, messages)`. Messages are buffered
 *   locally per-session — NO remote call happens at this stage.
 *
 * - **L1 (batch extraction / ingest)**: When the conversation count reaches
 *   `everyNConversations` OR the session goes idle for `l1IdleTimeoutSeconds`,
 *   the L1 Runner is invoked with all buffered messages. The runner receives
 *   `{ sessionKey, msg, bg_msg }` and is responsible for ingesting/extracting
 *   them (e.g. calling appendEvent, or running local extraction logic).
 *   `bg_msg` is reserved for background context; currently always empty.
 *
 * - **L2 (scene extraction)**: Per-session downward-only timer. After each
 *   L2 completion, the next fire time is set to `now + maxInterval`. When
 *   L1 completes (new memory event), the fire time is advanced (but never
 *   postponed) to `max(now + delay, lastL2 + minInterval)`. When the timer
 *   fires, if the session is cold (inactive > `sessionActiveWindowHours`),
 *   the timer is cancelled rather than triggering L2 — it will be re-armed
 *   by the next L1 event.
 *
 * - **L3 (persona generation)**: Global mutex (concurrency=1) + pending flag
 *   dedup. Triggered after L2 completes.
 *
 * ## Timer semantics
 *
 * L1 uses a **resettable timer** (classic idle/debounce): each conversation
 * resets the countdown to `l1IdleTimeoutSeconds`. When the timer fires,
 * buffered messages are flushed through L1.
 *
 * L2 uses a **downward-only timer**: the scheduled fire time can only be
 * moved earlier, never later. This ensures both the maxInterval guarantee
 * and the delay-after-L1 responsiveness, while minInterval acts as a floor.
 *
 * Both timer types are implemented via `ManagedTimer` to eliminate
 * repetitive clear→set→fire→clean boilerplate.
 *
 * ## Trigger paths for L1
 *   A. **Conversation threshold** (primary): when `conversation_count >=
 *      effectiveThreshold` in `notifyConversation()`, L1 is triggered
 *      immediately with all buffered messages. The effective threshold
 *      is influenced by warm-up mode (see below).
 *   B. **Idle timeout** (catch-up): when a session goes idle for
 *      `l1IdleTimeoutSeconds`, L1 fires with whatever messages have
 *      been buffered (below threshold).
 *   C. **Shutdown flush**: on graceful shutdown, all pending buffers
 *      are flushed through L1 then L2.
 *
 * ## Warm-up mode
 *
 * When `enableWarmup` is true (default), new sessions use an exponentially
 * increasing L1 trigger threshold instead of jumping straight to
 * `everyNConversations`. The sequence is: 1 → 2 → 4 → 8 → ... →
 * everyNConversations. This ensures early conversations are processed
 * quickly (first conversation triggers L1 immediately), while gradually
 * reducing processing frequency as the session matures.
 *
 * ## flushSession
 *
 * Per-session flush — scoped end-of-session handling. Semantically different
 * from `destroy`:
 *   - `destroy` tears down the *whole* scheduler (process shutdown).
 *   - `flushSession` only processes the one session identified by
 *     `sessionKey` and leaves every other session's timers, buffers, and
 *     pipeline state untouched. This is the correct semantic for the
 *     Gateway's `POST /session/end` endpoint and for Hermes' `on_session_end`
 *     callback.
 */

export { MemoryPipelineManager } from "./pipeline/manager.js";
export type { CapturedMessage, PipelineConfig, L1Runner, L1RunnerResult, L2Runner, L2RunnerResult, L3Runner, PipelineStatePersister, SessionTimerState } from "./pipeline/types.js";
