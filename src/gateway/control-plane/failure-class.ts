/**
 * Failure classes and their reactions (tz-09 Ф2b, P9 §4.2).
 *
 * "Retry" is not a reaction: the class decides. A transient launcher error
 * earns another attempt of the SAME run, a stale workset earns a NEW run, a
 * partial apply earns reconciliation and no retry at all. Getting this wrong
 * is how a keeper burns its budget re-running a diff that can never apply.
 *
 * The retry budget itself belongs to the role contract (tz-01,
 * `policy.retryBudget`, already consumed by the dispatcher) — this module
 * classifies, it does not count.
 */

export type FailureClass =
  | "transient-launcher"
  | "invalid-role-output"
  | "invalid-critic-output"
  | "manifest-conflict"
  | "partial-apply"
  | "timeout-cancel";

export type FailureReaction =
  /** Another LaunchAttempt of the same Run. */
  | "new-launch-attempt"
  /** Another CriticAttempt over the SAME candidate — never a regeneration. */
  | "new-critic-attempt"
  /** A new Assignment and a new Run with a fresh workset. */
  | "new-run"
  /** No retry: reconcile the oplog against the store (P7). */
  | "reconcile"
  /** Kill the process group; a late apply is refused. */
  | "kill-no-late-apply"
  /** Attempt or run is done — policy decides which, see `terminalForRun`. */
  | "attempt-or-terminal";

export interface Reaction {
  reaction: FailureReaction;
  /** True when the Run itself is finished, not just this attempt. */
  terminalForRun: boolean;
  /** Consumes one unit of the role's retry budget (tz-01). */
  consumesBudget: boolean;
}

const REACTIONS: Record<FailureClass, Reaction> = {
  "transient-launcher": {
    reaction: "new-launch-attempt",
    terminalForRun: false,
    consumesBudget: true,
  },
  "invalid-role-output": {
    reaction: "attempt-or-terminal",
    terminalForRun: false,
    consumesBudget: true,
  },
  "invalid-critic-output": {
    reaction: "new-critic-attempt",
    terminalForRun: false,
    consumesBudget: true,
  },
  "manifest-conflict": {
    // The workset the child reasoned about is gone: retrying the same diff
    // can only fail the same way.
    reaction: "new-run",
    terminalForRun: true,
    consumesBudget: false,
  },
  "partial-apply": {
    reaction: "reconcile",
    terminalForRun: true,
    consumesBudget: false,
  },
  "timeout-cancel": {
    reaction: "kill-no-late-apply",
    terminalForRun: true,
    consumesBudget: true,
  },
};

export function reactionFor(cls: FailureClass): Reaction {
  return REACTIONS[cls];
}

/**
 * Classify a failure from what the run already knows. `partial` comes from
 * the apply result, `stage` from where the failure happened — the message is
 * consulted last, and only for the shapes the executor actually emits.
 */
export function classifyFailure(input: {
  stage: "launch" | "role-output" | "critic" | "apply";
  message: string;
  partial?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
}): FailureClass {
  if (input.cancelled === true || input.timedOut === true) {
    return "timeout-cancel";
  }
  if (input.stage === "apply") {
    if (input.partial === true) return "partial-apply";
    if (
      /manifest drift|was updated since the diff was built/i.test(input.message)
    ) {
      return "manifest-conflict";
    }
    return "invalid-role-output";
  }
  if (input.stage === "critic") return "invalid-critic-output";
  if (input.stage === "role-output") return "invalid-role-output";
  return "transient-launcher";
}
