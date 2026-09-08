/**
 * Detached gateway work wrapper for OpenClaw 7.2+ admission compatibility.
 *
 * OpenClaw >= 7.2 introduced a gateway work admission mechanism that rejects
 * async subordinate tasks (like L1/L2/L3 memory extraction) after the main
 * agent turn ends (rootWork released). This module dynamically detects the
 * public `runDetachedWebhookWork` API (available since 7.2-beta.2) and wraps
 * the given work in an independent root work admission so that
 * `enqueueCommandInLane` sees `released=false` and accepts the task.
 *
 * On OpenClaw <= 7.1-2 where the admission mechanism does not exist,
 * the detection fails gracefully and the work runs directly (no wrapper).
 *
 * Version coverage:
 *   <= 7.1-2       : no admission mechanism → fallback (direct run)
 *   7.2-beta.1     : admission exists but no public API → fallback (known gap)
 *   >= 7.2-beta.2  : runDetachedWebhookWork available → wrapped
 */

type DetachedWorkFn = <T>(run: () => Promise<T>) => Promise<T>;

const TAG = "[memory-tdai] [detached-work]";

// Three-state probe cache:
//   undefined = not yet probed
//   null      = probed, not available (fallback to direct run)
//   function  = probed, available
let _detachedWorkFn: DetachedWorkFn | null | undefined;

/**
 * Run `work` inside an independent gateway root work admission when available.
 * Falls back to direct execution on OpenClaw versions without the API.
 */
export async function runDetachedWork<T>(
  work: () => Promise<T>,
  logger?: { debug?: (...args: unknown[]) => void },
): Promise<T> {
  if (_detachedWorkFn === undefined) {
    try {
      // Dynamic import: the subpath ./plugin-sdk/webhook-request-guards
      // exists in OpenClaw exports since 7.1-2, but the named export
      // runDetachedWebhookWork was only added in 7.2-beta.2.
      const mod = await import("openclaw/plugin-sdk/webhook-request-guards");
      if (typeof mod?.runDetachedWebhookWork === "function") {
        _detachedWorkFn = mod.runDetachedWebhookWork as DetachedWorkFn;
        logger?.debug?.(
          `${TAG} runDetachedWebhookWork detected — gateway admission wrapping enabled`,
        );
      } else {
        _detachedWorkFn = null;
        logger?.debug?.(
          `${TAG} runDetachedWebhookWork not exported — falling back to direct execution`,
        );
      }
    } catch {
      _detachedWorkFn = null;
      logger?.debug?.(
        `${TAG} webhook-request-guards import failed — falling back to direct execution`,
      );
    }
  }

  if (_detachedWorkFn) {
    return _detachedWorkFn(work);
  }
  return work();
}
