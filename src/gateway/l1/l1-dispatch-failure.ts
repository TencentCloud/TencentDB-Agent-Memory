import {
  L1AgentValidationError,
  L1DispatchError,
} from "../../core/record/l1-agent-errors.js";
import type {
  L1DispatchFailureKind,
  L1DispatchResult,
} from "../../core/record/l1-agent-types.js";
import { failL1Assignment, readL1Assignment } from "./l1-assignment-repo.js";
import { failL1Run } from "./l1-dispatch-runtime.js";
import { l1RetryAt } from "./l1-retry-backoff.js";

export function recordL1DispatchFailure(input: {
  dataDir: string;
  runId: string;
  assignmentId: string;
  error: unknown;
  now: () => number;
}): Extract<L1DispatchResult, { ok: false }> {
  const message = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  const kind: L1DispatchFailureKind = input.error instanceof L1DispatchError
    ? input.error.kind
    : input.error instanceof L1AgentValidationError
      ? "invalid-candidate"
      : "launch-failed";
  failL1Run(input.dataDir, input.runId, kind, input.now);
  const failureCount = readL1Assignment(
    input.dataDir,
    input.assignmentId,
  )?.failureCount ?? 0;
  failL1Assignment({
    dataDir: input.dataDir,
    assignmentId: input.assignmentId,
    runId: input.runId,
    error: message,
    nextRetryAt: l1RetryAt(input.now(), failureCount),
    nowIso: new Date(input.now()).toISOString(),
  });
  return { ok: false, kind, message };
}
