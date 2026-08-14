import { L1DispatchError } from "../../core/record/l1-agent-errors.js";
import type { L1ConflictCandidateRepository } from "../../core/record/l1-conflict-candidates.js";
import type {
  L1DispatchResult,
  L1ExtractionDispatcher,
} from "../../core/record/l1-agent-types.js";
import type { Logger } from "../../core/types.js";
import { assertLiveRoleLease } from "../../agents/role-execution-lease.js";
import type { RoleExecutionLease } from "../../agents/role-execution-lease.js";
import type { ResolvedRoleContract } from "../consolidation/role-contract-types.js";
import type { RoleLauncher, RunningHandle } from "../consolidation/launchers/types.js";
import { startL1AssignmentEpoch } from "./l1-assignment-repo.js";
import {
  executeL1Attempt,
  type L1RetryFeedback,
} from "./l1-dispatch-attempt.js";
import { openL1Run } from "./l1-dispatch-runtime.js";

type DispatchInput = Parameters<
  L1ExtractionDispatcher["dispatchExtraction"]
>[0];

export async function executeL1RolePair(input: {
  dataDir: string;
  input: DispatchInput;
  extractor: ResolvedRoleContract;
  critic: ResolvedRoleContract;
  runId: string;
  scratchDir: string;
  launcherFor: (id: string) => RoleLauncher;
  conflicts: L1ConflictCandidateRepository;
  lease: RoleExecutionLease;
  logger: Logger;
  maxMemoriesPerSession: number;
  now: () => number;
  onHandleStarted: (attemptId: string, handle: RunningHandle) => void;
  onHandleSettled: (attemptId: string) => void;
}): Promise<L1DispatchResult> {
  assertLiveRoleLease(input.lease);
  const nowIso = new Date(input.now()).toISOString();
  const assignmentId = input.input.workset.assignmentId;
  if (
    !startL1AssignmentEpoch({
      dataDir: input.dataDir,
      assignmentId,
      runId: input.runId,
      roleContractHash: input.extractor.contractHash,
      nowMs: input.now(),
      nowIso,
    })
  )
    return { ok: false, kind: "busy", message: "assignment is not retryable" };
  const { owner, fence } = await openL1Run({
    dataDir: input.dataDir,
    scratchDir: input.scratchDir,
    runId: input.runId,
    workset: input.input.workset,
    contract: input.extractor,
    now: input.now,
  });
  const attempts = Math.max(
    1,
    Math.min(
      input.extractor.policy.retryBudget,
      input.critic.policy.retryBudget,
    ),
  );
  let retry: L1RetryFeedback | null = null;
  let lastError: unknown = null;
  for (let ordinal = 1; ordinal <= attempts; ordinal += 1) {
    assertLiveRoleLease(input.lease);
    try {
      const outcome = await executeL1Attempt({
        ...input,
        workset: input.input.workset,
        owner,
        fence,
        ordinal,
        retry,
      });
      if (outcome.approved) return outcome.result;
      retry = { reasons: outcome.reasons, conflicts: outcome.conflicts };
      lastError = new L1DispatchError(
        "critic-rejected",
        `critic rejected: ${outcome.reasons.join("; ")}`,
      );
    } catch (error) {
      lastError = error;
      retry = {
        reasons: [error instanceof Error ? error.message : String(error)],
        conflicts: retry?.conflicts ?? [],
      };
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new L1DispatchError("critic-rejected", "role retry budget exhausted");
}
