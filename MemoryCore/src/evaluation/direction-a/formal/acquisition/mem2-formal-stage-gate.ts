import { readFile } from "node:fs/promises";
import { hashCanonical } from "../core/canonical.js";
import type { TaskAgentExecutor } from "../executors/task-agent-executor.js";
import {
  assertImmutableMem2PaidAuthorization,
  assertMem2PaidAuthorizationRequest,
  type ImmutableMem2PaidAuthorization,
  type Mem2PaidAuthorizationRequest,
  type Mem2PaidPurpose,
} from "./mem2-formal-stage-authorization.js";

const permitBrand = Symbol("Mem2PaidExecutionPermit");

export interface Mem2PaidExecutionPermit {
  readonly [permitBrand]: true;
  purpose: Mem2PaidPurpose;
  authorizationHash: string;
  requestHash: string;
  snapshotHash: string;
  commit: string;
  tree: string;
  profileHash: string;
  protocolHash: string;
  partitionBindingHash: string;
  baseFrozenDesignBindingHash?: string;
  preCalSequenceAmendmentSha256?: string;
  maximumProviderCalls: number;
  maximumCostCny: number;
}

export interface Mem2PreExecutionState {
  providerCalls: number;
  modelCalls: number;
  normalCalls: number;
  fullCalls: number;
  removeCalls: number;
  formalTrainDevCalls: number;
  calCausalY: number;
  sealedTestCausalY: number;
  secretReadEvents: number;
}

export function authorizeMem2PaidExecution(input: {
  request: Mem2PaidAuthorizationRequest;
  authorization?: ImmutableMem2PaidAuthorization;
  liveCommit: string;
  liveTree: string;
  liveBranch: string;
  snapshotHash: string;
  authorityBindingHash: string;
  baseFrozenDesignBindingHash?: string;
  preCalSequenceAmendmentSha256?: string;
  verifierHash: string;
  profileHash: string;
  protocolHash: string;
  partitionBindingHash: string;
  budgetLedgerHash: string;
  budgetLedgerPredecessorHash?:string;
  state: Mem2PreExecutionState;
}): Mem2PaidExecutionPermit {
  assertMem2PaidAuthorizationRequest(input.request);
  if (!input.authorization) throw new Error(input.request.purpose === "POST_ADAPTER_MINIMUM_SMOKE"
    ? "RESEARCHER_AUTHORIZATION_REQUIRED_FOR_POST_ADAPTER_MINIMUM_SMOKE"
    : "RESEARCHER_STAGE_AUTHORIZATION_REQUIRED");
  assertImmutableMem2PaidAuthorization(input.authorization, input.request);
  if (input.request.candidateCommit !== input.liveCommit || input.request.candidateTree !== input.liveTree
    || input.request.candidateBranch !== input.liveBranch
    || input.request.candidateSnapshotHash !== input.snapshotHash || input.request.profileHash !== input.profileHash
    || input.request.protocolHash !== input.protocolHash || input.request.authorityBindingHash !== input.authorityBindingHash
    || (input.request.purpose === "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY" &&
      (input.request.baseFrozenDesignBindingHash !== input.baseFrozenDesignBindingHash
      || input.request.preCalSequenceAmendmentSha256 !== input.preCalSequenceAmendmentSha256))
    || input.request.verifierHash !== input.verifierHash
    || input.request.budgetLedgerPredecessorHash !== (input.budgetLedgerPredecessorHash??input.budgetLedgerHash)
    || input.partitionBindingHash !== hashCanonical({
      freshPopulationRegistryHash: input.request.freshPopulationRegistryHash,
      formalExclusionRegistryHash: input.request.formalExclusionRegistryHash,
      trainPartitionHash: input.request.trainPartitionHash,
      devPartitionHash: input.request.devPartitionHash,
      protectedCalPartitionHash: input.request.protectedCalPartitionHash,
      protectedSealedTestPartitionHash: input.request.protectedSealedTestPartitionHash,
    })) throw new Error("MEM2_PAID_EXECUTION_BINDING_DRIFT");
  if (Object.values(input.state).some((value) => value !== 0)) throw new Error("MEM2_PAID_EXECUTION_PRESTATE_NOT_ZERO");
  return Object.freeze({
    [permitBrand]: true as const,
    purpose: input.request.purpose,
    authorizationHash: input.authorization.contentHash,
    requestHash: input.request.contentHash,
    snapshotHash: input.snapshotHash,
    commit: input.liveCommit,
    tree: input.liveTree,
    profileHash: input.profileHash,
    protocolHash: input.protocolHash,
    partitionBindingHash: input.partitionBindingHash,
    baseFrozenDesignBindingHash: input.baseFrozenDesignBindingHash,
    preCalSequenceAmendmentSha256: input.preCalSequenceAmendmentSha256,
    maximumProviderCalls: input.request.maximumProviderCalls,
    maximumCostCny: input.request.maximumCostCny,
  });
}

export function assertMem2PaidExecutionPermit(permit: Mem2PaidExecutionPermit, purpose?: Mem2PaidPurpose): void {
  if (!permit || permit[permitBrand] !== true || !permit.authorizationHash || !permit.requestHash
    || (purpose && permit.purpose !== purpose)) throw new Error("MEM2_PAID_EXECUTION_PERMIT_INVALID");
}

export function createMem2ExecutorAfterAuthorization(permit: Mem2PaidExecutionPermit,
  factory: () => TaskAgentExecutor): TaskAgentExecutor {
  assertMem2PaidExecutionPermit(permit);
  const executor = factory();
  if (executor.executorKind !== "PRODUCTION_AUTHORIZED") throw new Error("MEM2_AUTHORIZED_EXECUTOR_KIND_INVALID");
  return executor;
}

export async function loadDirectionASecretsAfterMem2Authorization(path: string,
  permit: Mem2PaidExecutionPermit): Promise<Record<string, string>> {
  assertMem2PaidExecutionPermit(permit);
  const text = await readFile(path, "utf8");
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Malformed Direction-A secret configuration line");
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}
