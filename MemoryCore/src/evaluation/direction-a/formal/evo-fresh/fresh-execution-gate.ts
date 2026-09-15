import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../acquisition/execution-profile.js";
import { FRESH_PAID_AUTHORITY, assertFreshPaidAuthority, FRESH_ACTIVE_PREFIX_N, FRESH_EXPECTED_CALLS,
  FRESH_MAX_CALLS, FRESH_P95_RESERVATION_CNY, FRESH_HISTORICAL_FRESH_SPEND_CNY, FRESH_INCREMENTAL_BUDGET_CAP_CNY,
  FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY, FRESH_PROTECTED_TOTAL_CNY, FRESH_PEAK_PRICING } from "./fresh-paid-authority.js";
import { FRESH_N, FRESH_PREFIX_HASH, FRESH_RUNTIME_ROOT, FRESH_ACTIVE_PREFIX_TASK_HASH, FRESH_FORBIDDEN_TAIL_TASK_IDS,
  assertFreshExactManifest, assertFreshPreparedExecutionManifest, assertFreshNoForbiddenTailTask,
  type FreshExactManifest, type FreshPreparedExecutionManifest } from "./fresh-manifest.js";

export const FRESH_REQUIRED_FORBIDDEN = ["TRAIN", "T2", "Q6", "PAIR_5", "N10", "EXTRA_TRAIN",
  "FRESH_Y_BEFORE_PRE_Y_SEAL", "INTERLEAVED_NORMAL_AND_CAUSAL_Y", "MODEL_REFIT", "POLICY_REFIT_AFTER_Y",
  "OUTCOME_ADAPTIVE_DEEPENING", "TASK_6", "TASK_7", "TASK_8", "TASK_9",
  "ADAPTIVE_SAMPLE_EXTENSION_AFTER_TASK_5", "REQUALIFY_DENOMINATOR_IN_THIS_ROUND"] as const;

export interface FreshAuthorizationRequest {
  schemaVersion: "direction-a.evo-fresh-n9-authorization-request.v1";
  decisionId: "EVO_FRESH_PEAK100_PREFIX5_2026_09_14";
  status: "PENDING_RESEARCHER_REAUTHORIZATION";
  requestedStage: "EVO_FRESH_ENGINEERING_HOLDOUT";
  authorized: false;
  materializedResearcherApproval: false;
  allowPaidExecution: false;
  freshN: typeof FRESH_N;
  activePrefixN: typeof FRESH_ACTIVE_PREFIX_N;
  peakPricing: typeof FRESH_PEAK_PRICING;
  frozenN9PrefixLength: 9;
  activePrefixTaskHash: typeof FRESH_ACTIVE_PREFIX_TASK_HASH;
  forbiddenTailTaskIds: readonly string[];
  freshPrefixHash: typeof FRESH_PREFIX_HASH;
  exactManifestHash: string;
  preparedManifestSchema: "direction-a.evo-fresh-n9-prepared-manifest.v1" | "direction-a.evo-fresh-n9-prepared-manifest.v2" | "direction-a.evo-fresh-n9-prepared-manifest.v3";
  preparedManifestContractHash: string;
  denominatorQualificationHash?: string;
  failFastNormalizationSpecHash?: string;
  runtimeRoot: string;
  executionProfileHash: string;
  paidAuthorityHash: string;
  expectedProviderCalls: 540;
  maximumProviderCalls: 660;
  priorReconciledSpendCny: 10.022517;
  priorSpendTreatment: "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100";
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION";
  budgetNeverFailsClosed: true;
  freshProtectedReservationCny: 19.868557;
  incrementalBudgetCapCny: 100;
  absoluteAccountingCeilingCny: 100;
  protectedTotalCny: 29.891074;
  globalHardCapCny: 100;
  researcherBudgetExtensionMaximumCny: 0;
  approvalStringFormat: "APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>";
  requiredBindingPaths: Record<string, string>;
  requiredBindings: Record<string, string>;
  requiredBindingsCount: number;
  requiredBindingsHash: string;
  forbidden: string[];
  contentHash: string;
}

export interface FreshImmutableGrant {
  schemaVersion: "direction-a.evo-fresh-n9-authorization.v1";
  status: "IMMUTABLE_APPROVED";
  requestedStage: "EVO_FRESH_ENGINEERING_HOLDOUT";
  authorizationRequestHash: string;
  approvalSource: "RESEARCHER";
  approvalText: string;
  approvalTextHash: string;
  freshN: typeof FRESH_N;
  activePrefixN: typeof FRESH_ACTIVE_PREFIX_N;
  peakPricing: typeof FRESH_PEAK_PRICING;
  incrementalBudgetCapCny: 100;
  freshProtectedReservationCny: 19.868557;
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION";
  budgetNeverFailsClosed: true;
  freshPrefixHash: typeof FRESH_PREFIX_HASH;
  exactManifestHash: string;
  preparedManifestContractHash: string;
  runtimeRoot: string;
  executionProfileHash: string;
  paidAuthorityHash: string;
  requiredBindings: Record<string, string>;
  forbidden: string[];
  allowPaidExecution: true;
  contentHash: string;
}

declare const freshPermitBrand: unique symbol;
export type AuthorizedFreshExecutionPermit = { readonly [freshPermitBrand]: true; kind: "EVO_FRESH_ENGINEERING_HOLDOUT";
  authorizationHash: string; authorizationRequestHash: string; exactManifestHash: string; preparedManifestHash: string;
  runtimeRoot: string; profileHash: string; paidAuthorityHash: string; requiredBindingsHash: string };

export function assertFreshAuthorizationRequest(request: FreshAuthorizationRequest): void {
  const { contentHash, ...body } = request;
  if (hashCanonical(body) !== contentHash) throw new Error("FRESH_AUTHORIZATION_REQUEST_CONTENT_HASH_MISMATCH");
  if (request.schemaVersion !== "direction-a.evo-fresh-n9-authorization-request.v1" || request.status !== "PENDING_RESEARCHER_REAUTHORIZATION"
    || request.requestedStage !== "EVO_FRESH_ENGINEERING_HOLDOUT" || request.authorized || request.materializedResearcherApproval
    || request.allowPaidExecution || request.freshN !== FRESH_N || request.freshPrefixHash !== FRESH_PREFIX_HASH
    || request.activePrefixN !== FRESH_ACTIVE_PREFIX_N || request.peakPricing !== FRESH_PEAK_PRICING
    || request.frozenN9PrefixLength !== 9 || request.activePrefixTaskHash !== FRESH_ACTIVE_PREFIX_TASK_HASH
    || hashCanonical(request.forbiddenTailTaskIds) !== hashCanonical(FRESH_FORBIDDEN_TAIL_TASK_IDS)
    || request.runtimeRoot !== FRESH_RUNTIME_ROOT || !/^[a-f0-9]{64}$/.test(request.preparedManifestContractHash)
    || !(["direction-a.evo-fresh-n9-prepared-manifest.v1", "direction-a.evo-fresh-n9-prepared-manifest.v2", "direction-a.evo-fresh-n9-prepared-manifest.v3"] as const).includes(request.preparedManifestSchema)
    || request.expectedProviderCalls !== FRESH_EXPECTED_CALLS || request.maximumProviderCalls !== FRESH_MAX_CALLS
    || request.globalHardCapCny !== FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY
    || request.absoluteAccountingCeilingCny !== FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY
    || request.incrementalBudgetCapCny !== FRESH_INCREMENTAL_BUDGET_CAP_CNY
    || request.freshProtectedReservationCny !== FRESH_P95_RESERVATION_CNY
    || request.priorReconciledSpendCny !== FRESH_HISTORICAL_FRESH_SPEND_CNY
    || request.priorSpendTreatment !== "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100"
    || request.budgetRole !== "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION" || request.budgetNeverFailsClosed !== true
    || request.researcherBudgetExtensionMaximumCny !== 0
    || request.protectedTotalCny !== FRESH_PROTECTED_TOTAL_CNY
    || request.requiredBindingsCount !== Object.keys(request.requiredBindings).length
    || request.requiredBindingsCount !== Object.keys(request.requiredBindingPaths).length
    || request.requiredBindingsHash !== hashCanonical(request.requiredBindings)
    || (request.preparedManifestSchema !== "direction-a.evo-fresh-n9-prepared-manifest.v1"
      && (!/^[a-f0-9]{64}$/.test(request.denominatorQualificationHash ?? "")
        || !/^[a-f0-9]{64}$/.test(request.failFastNormalizationSpecHash ?? "")))) throw new Error("FRESH_AUTHORIZATION_REQUEST_SCOPE_MISMATCH");
  if (FRESH_REQUIRED_FORBIDDEN.some((entry) => !request.forbidden.includes(entry))) throw new Error("FRESH_AUTHORIZATION_REQUEST_FORBIDDEN_SCOPE_INCOMPLETE");
}

export function createFreshImmutableGrant(input: { request: FreshAuthorizationRequest; exact: FreshExactManifest;
  profile: RealExecutionProfile; approvalText: string }): FreshImmutableGrant {
  assertFreshAuthorizationRequest(input.request); assertFreshExactManifest(input.exact);
  assertRealExecutionProfile(input.profile); assertFreshPaidAuthority();
  assertFreshNoForbiddenTailTask(input.exact.tasks.map((row) => row.taskId));
  if (input.request.exactManifestHash !== input.exact.contentHash || input.request.executionProfileHash !== input.profile.contentHash
    || input.request.paidAuthorityHash !== FRESH_PAID_AUTHORITY.contentHash) {
    throw new Error("FRESH_GRANT_MATERIALIZER_BINDING_MISMATCH");
  }
  const expectedApproval = `APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT ${input.request.contentHash}`;
  if (input.approvalText !== expectedApproval) throw new Error("FRESH_RESEARCHER_APPROVAL_STRING_MISMATCH");
  const body = { schemaVersion: "direction-a.evo-fresh-n9-authorization.v1" as const, status: "IMMUTABLE_APPROVED" as const,
    requestedStage: "EVO_FRESH_ENGINEERING_HOLDOUT" as const, authorizationRequestHash: input.request.contentHash,
    approvalSource: "RESEARCHER" as const, approvalText: input.approvalText, approvalTextHash: hashCanonical(input.approvalText),
    freshN: FRESH_N, activePrefixN: FRESH_ACTIVE_PREFIX_N, peakPricing: FRESH_PEAK_PRICING,
    incrementalBudgetCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY, freshProtectedReservationCny: FRESH_P95_RESERVATION_CNY,
    budgetRole: input.request.budgetRole, budgetNeverFailsClosed: input.request.budgetNeverFailsClosed,
    freshPrefixHash: FRESH_PREFIX_HASH, exactManifestHash: input.exact.contentHash,
    preparedManifestContractHash: input.request.preparedManifestContractHash, runtimeRoot: input.request.runtimeRoot,
    executionProfileHash: input.profile.contentHash, paidAuthorityHash: FRESH_PAID_AUTHORITY.contentHash,
    requiredBindings: structuredClone(input.request.requiredBindings), forbidden: [...input.request.forbidden], allowPaidExecution: true as const };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as FreshImmutableGrant;
}

export function authorizeFreshExecutionPermit(input: { grant?: FreshImmutableGrant; request: FreshAuthorizationRequest;
  exact: FreshExactManifest; prepared: FreshPreparedExecutionManifest; profile: RealExecutionProfile }): AuthorizedFreshExecutionPermit {
  assertFreshAuthorizationRequest(input.request); assertFreshExactManifest(input.exact); assertRealExecutionProfile(input.profile);
  assertFreshPreparedExecutionManifest(input.prepared, input.exact); assertFreshPaidAuthority();
  if (!input.grant) throw new Error("FRESH_PAID_EXECUTION_LOCKED:IMMUTABLE_GRANT_ABSENT");
  const { contentHash, ...body } = input.grant;
  if (hashCanonical(body) !== contentHash) throw new Error("FRESH_PAID_EXECUTION_LOCKED:GRANT_HASH_MISMATCH");
  if (input.grant.schemaVersion !== "direction-a.evo-fresh-n9-authorization.v1" || input.grant.status !== "IMMUTABLE_APPROVED"
    || input.grant.requestedStage !== "EVO_FRESH_ENGINEERING_HOLDOUT" || !input.grant.allowPaidExecution
    || input.grant.freshN !== FRESH_N || input.grant.activePrefixN !== FRESH_ACTIVE_PREFIX_N
    || input.grant.peakPricing !== FRESH_PEAK_PRICING || input.grant.incrementalBudgetCapCny !== FRESH_INCREMENTAL_BUDGET_CAP_CNY
    || input.grant.freshProtectedReservationCny !== FRESH_P95_RESERVATION_CNY
    || input.grant.budgetRole !== "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION" || input.grant.budgetNeverFailsClosed !== true
    || input.grant.freshPrefixHash !== FRESH_PREFIX_HASH) throw new Error("FRESH_PAID_EXECUTION_LOCKED:GRANT_SCOPE_MISMATCH");
  if (input.grant.authorizationRequestHash !== input.request.contentHash || input.grant.exactManifestHash !== input.exact.contentHash
    || input.grant.preparedManifestContractHash !== input.request.preparedManifestContractHash || input.grant.runtimeRoot !== input.prepared.runtimeRoot
    || input.grant.executionProfileHash !== input.profile.contentHash || input.grant.paidAuthorityHash !== FRESH_PAID_AUTHORITY.contentHash
    || hashCanonical(input.grant.requiredBindings) !== hashCanonical(input.request.requiredBindings)) {
    throw new Error("FRESH_PAID_EXECUTION_LOCKED:GRANT_BINDING_MISMATCH");
  }
  if ((input.request.preparedManifestSchema === "direction-a.evo-fresh-n9-prepared-manifest.v2" || input.request.preparedManifestSchema === "direction-a.evo-fresh-n9-prepared-manifest.v3")
    && (input.prepared.schemaVersion !== input.request.preparedManifestSchema
      || input.prepared.preparationProtocolHash !== input.request.preparedManifestContractHash
      || input.prepared.denominatorQualificationHash !== input.request.denominatorQualificationHash)) {
    throw new Error("FRESH_PAID_EXECUTION_LOCKED:VERSIONED_MEASUREMENT_PROTOCOL_MISMATCH");
  }
  if (input.grant.approvalText !== `APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT ${input.request.contentHash}`
    || FRESH_REQUIRED_FORBIDDEN.some((entry) => !input.grant!.forbidden.includes(entry))) {
    throw new Error("FRESH_PAID_EXECUTION_LOCKED:APPROVAL_OR_FORBIDDEN_SCOPE_MISMATCH");
  }
  return { kind: "EVO_FRESH_ENGINEERING_HOLDOUT", authorizationHash: contentHash,
    authorizationRequestHash: input.request.contentHash, exactManifestHash: input.exact.contentHash,
    preparedManifestHash: input.prepared.contentHash, runtimeRoot: input.prepared.runtimeRoot, profileHash: input.profile.contentHash,
    paidAuthorityHash: FRESH_PAID_AUTHORITY.contentHash, requiredBindingsHash: hashCanonical(input.request.requiredBindings) } as AuthorizedFreshExecutionPermit;
}

export function assertFreshImmutableGrantWrite(existing: FreshImmutableGrant, intended: FreshImmutableGrant): "IDEMPOTENT" {
  const { contentHash: existingHash, ...existingBody } = existing;
  const { contentHash: intendedHash, ...intendedBody } = intended;
  if (hashCanonical(existingBody) !== existingHash || hashCanonical(intendedBody) !== intendedHash
    || existingHash !== intendedHash || hashCanonical(existing) !== hashCanonical(intended)) {
    throw new Error("FRESH_IMMUTABLE_GRANT_OVERWRITE_FORBIDDEN");
  }
  return "IDEMPOTENT";
}

export async function loadFreshSecretsAfterAllPreconditions(input: { permit: AuthorizedFreshExecutionPermit;
  phase: "PHASE1_NORMAL" | "PHASE2_PRE_Y_FREEZE" | "PHASE3_CAUSAL_Y"; preparedManifestPass: boolean; dockerReady: boolean;
  journalUnambiguous: boolean; reservationProven: boolean; loader: () => Promise<Record<string, string>> }): Promise<Record<string, string>> {
  if (input.permit.kind !== "EVO_FRESH_ENGINEERING_HOLDOUT") throw new Error("FRESH_SECRET_LOAD_FORBIDDEN_INVALID_PERMIT");
  if (input.phase === "PHASE2_PRE_Y_FREEZE") throw new Error("FRESH_PHASE2_SECRET_READ_STRUCTURALLY_FORBIDDEN");
  if (!input.preparedManifestPass) throw new Error("FRESH_SECRET_LOAD_FORBIDDEN_PREPARED_MANIFEST_INVALID");
  if (!input.dockerReady) throw new Error("FRESH_SECRET_LOAD_FORBIDDEN_DOCKER_UNAVAILABLE");
  if (!input.journalUnambiguous) throw new Error("FRESH_SECRET_LOAD_FORBIDDEN_AMBIGUOUS_JOURNAL");
  if (!input.reservationProven) throw new Error("FRESH_SECRET_LOAD_FORBIDDEN_BEFORE_RESERVATION");
  return input.loader();
}
