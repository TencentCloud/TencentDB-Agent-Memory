/**
 * Focused, zero-provider proof for the FINAL Fresh recovery round only.
 *
 * Covers the researcher's minimal list: bound artifacts exist and re-derive; the binding surface is
 * restored; the n3 prepared bundle must carry the hash-bound external prefix artifact; the runner can
 * legally continue the historical n3 try-1..3 with exactly one bounded recovery; v3 prepared manifests
 * are supported; the runner resumes the live state without re-running n1/n2; Phase2/Phase3 transitions
 * still hold; and money is telemetry only.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "./core/canonical.js";
import { createPairSchedule } from "./acquisition/integrity.js";
import { createFreshExactManifest, assertFreshPreparedExecutionManifest, FRESH_RUNTIME_ROOT } from "./evo-fresh/fresh-manifest.js";
import { assertFreshDenominatorQualification, type FreshDenominatorQualification } from "./evo-fresh/failfast-case-accounting.js";
import { N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH,
  N3_PREFIX_ENVIRONMENT_ATTEMPT_ID, N3_PREFIX_ENVIRONMENT_RECOVERY_ID,
  type N3PrefixEnvironmentManifest } from "./evo-fresh/fresh-prefix-environment-recovery.js";
import { assertFreshAuthorizationRequest, type FreshAuthorizationRequest } from "./evo-fresh/fresh-execution-gate.js";
import { verifyFreshRequiredBindings } from "./evo-fresh/fresh-binding-verification.js";
import { createFreshInitialBudgetExposure, freshSpendTelemetry, isProviderRefusal, projectFreshBudgetExposure,
  reserveFreshWholeTaskBeforeStart, FRESH_HISTORICAL_FRESH_SPEND_CNY, FRESH_REMAINING_FRESH_BUDGET_CNY,
  FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY } from "./evo-fresh/fresh-paid-authority.js";
import { assertFreshTaskReplacementPool, freshBoundedRecoveryIsAvailable, nextFreshAction,
  sealFreshRunState, type FreshSlotState } from "./evo-fresh/fresh-prey-runtime.js";

const memoryCoreRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const repositoryRoot = resolve(memoryCoreRoot, "..");
const directionADocsRoot = resolve(memoryCoreRoot, "docs", "direction-a");
const closure = resolve(directionADocsRoot, "evidence", "evo", "fresh-authority");
const runtimeRoot = resolve(directionADocsRoot, "evidence", "fresh", "runtime");
const json = <T>(name: string): T => JSON.parse(readFileSync(resolve(closure, name), "utf8")) as T;

const repositoryBindingPath = (relativePath: string): string => {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("MemoryCore/")) return normalized;
  const closurePrefix = "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1/";
  if (normalized.startsWith(closurePrefix)) {
    return `MemoryCore/docs/direction-a/evidence/evo/fresh-authority/${normalized.slice(closurePrefix.length)}`;
  }
  const postT1Prefix = "Direction_A_Evo_PostT1_Requalification_Closure_v2/";
  if (normalized.startsWith(postT1Prefix)) {
    return `MemoryCore/docs/direction-a/evidence/evo/post-t1-source/${normalized.split("/").at(-1)}`;
  }
  const postCalPrefix = "Direction_A_PostCAL_Model_Value_v2_1/";
  if (normalized.startsWith(postCalPrefix)) {
    return `MemoryCore/docs/direction-a/evidence/mem2/untouched69/model-policy/${normalized.split("/").at(-1)}`;
  }
  throw new Error(`NO_REPOSITORY_BINDING_PATH:${normalized}`);
};

const verifyRequiredBindings = (request: FreshAuthorizationRequest): number => {
  const requiredBindingPaths = Object.fromEntries(Object.entries(request.requiredBindingPaths)
    .map(([key, relativePath]) => [key, repositoryBindingPath(relativePath)]));
  return verifyFreshRequiredBindings(repositoryRoot, { ...request, requiredBindingPaths });
};

const assertPortableN3PrefixEnvironmentManifest = (): void => {
  const manifest = json<N3PrefixEnvironmentManifest>("06_N3_PREFIX_ENVIRONMENT_MANIFEST.json");
  const contract = json<{ prefixEnvironmentManifestHash: string }>("09_PREPARED_MANIFEST_CONTRACT.json");
  const { contentHash, ...body } = manifest;
  if (hashCanonical(body) !== contentHash || contract.prefixEnvironmentManifestHash !== contentHash) {
    throw new Error("CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE");
  }
};
const exact = createFreshExactManifest();
const N3_TASK = "theme_d12_w1_automation_productivity_greenfield_implementation";
const N3_GROUP = `${N3_TASK}:target-round-7`;

const normal = (attempt: number, status: FreshSlotState["status"]): FreshSlotState => ({ taskId: N3_TASK, causalGroupId: N3_GROUP,
  arm: "NORMAL", attempt, attemptId: `fresh-n9-phase1-3-normal-try-${attempt}`, status });
const historicalN3 = [normal(1, "TECHNICAL_INVALID"), normal(2, "TECHNICAL_INVALID"), normal(3, "TECHNICAL_INVALID")];

describe("final Fresh recovery closure", () => {
  it("1. every artifact the request binds really exists on disk", () => {
    const request = json<Record<string, string>>("10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
    for (const name of ["02_ACTIVE_PREFIX5_EXACT_MANIFEST.json", "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json",
      "04_PREFIX5_SPEND_TELEMETRY_POLICY.json", "05_FAILFAST_NORMALIZATION_SPEC.json", "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json",
      "07_ROLLING_WHOLE_TASK_RESERVE.json", "08_N3_RECOVERY_SEMANTICS.json", "09_PREPARED_MANIFEST_CONTRACT.json",
      "11_SUPERSEDED_FRESH_AUTHORIZATIONS.json", "12_FINAL_TRANSITIVE_BINDING_MANIFEST.json"]) {
      expect(existsSync(resolve(closure, name))).toBe(true);
    }
    expect(request.denominatorQualificationHash).toBe(json<{ contentHash: string }>("03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json").contentHash);
    expect(request.failFastNormalizationSpecHash).toBe(json<{ contentHash: string }>("05_FAILFAST_NORMALIZATION_SPEC.json").contentHash);
    expect(request.preparedManifestContractHash).toBe(json<{ contentHash: string }>("09_PREPARED_MANIFEST_CONTRACT.json").contentHash);
  });

  it("2. every bound artifact hash is mechanically recomputable from its own bytes", () => {
    for (const name of ["01_PEAK100_PREFIX5_BUDGET_TELEMETRY_DECISION.json", "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json",
      "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json", "04_PREFIX5_SPEND_TELEMETRY_POLICY.json", "05_FAILFAST_NORMALIZATION_SPEC.json",
      "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json", "07_ROLLING_WHOLE_TASK_RESERVE.json", "08_N3_RECOVERY_SEMANTICS.json",
      "09_PREPARED_MANIFEST_CONTRACT.json", "11_SUPERSEDED_FRESH_AUTHORIZATIONS.json", "12_FINAL_TRANSITIVE_BINDING_MANIFEST.json"]) {
      const document = json<Record<string, unknown>>(name);
      const { contentHash, ...body } = document as { contentHash: string };
      expect(typeof contentHash).toBe("string");
      expect(hashCanonical(body)).toBe(contentHash);
    }
    const request = json<{ contentHash: string } & Record<string, unknown>>("10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
    const { contentHash, ...body } = request;
    expect(hashCanonical(body)).toBe(contentHash);
    assertFreshAuthorizationRequest(request as unknown as FreshAuthorizationRequest);
    expect(() => assertFreshDenominatorQualification(json<FreshDenominatorQualification>("03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json"), exact)).not.toThrow();
    expect(() => assertPortableN3PrefixEnvironmentManifest()).not.toThrow();
  });

  it("3. restores the full defence-in-depth binding surface, never the 8-path minimal set", () => {
    const request = json<{ requiredBindingPaths: Record<string, string>; requiredBindingsCount: number }>("10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
    expect(request.requiredBindingsCount).toBeGreaterThan(50);
    expect(verifyRequiredBindings(request as FreshAuthorizationRequest)).toBe(request.requiredBindingsCount);
    const paths = Object.values(request.requiredBindingPaths);
    for (const required of ["MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.ts",
      "MemoryCore/src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.ts",
      "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.ts",
      "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.ts",
      "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-prey-runtime.ts",
      "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.ts",
      "MemoryCore/scripts/direction-a/formal/evo-fresh-paid-run.ts",
      "MemoryCore/scripts/direction-a/formal/evo-fresh-prepare.ts",
      "MemoryCore/.research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json",
      "MemoryCore/src/evaluation/direction-a/formal/acquisition/journal.ts",
      "MemoryCore/src/evaluation/direction-a/formal/acquisition/integrity.ts",
      "Direction_A_PostCAL_Model_Value_v2_1/11_PROPOSED_V2_FINAL_MODEL.json",
      "Direction_A_PostCAL_Model_Value_v2_1/12_BASELINE_V2_FINAL_MODEL.json",
      "Direction_A_Evo_PostT1_Requalification_Closure_v2/06_REPAIRED_POST_T1_8TASK_10GROUP_BANK.json"]) {
      expect(paths).toContain(required);
    }
  });

  it("4. requires the hash-bound external prefix artifact for the n3 prepared bundle (v3)", () => {
    const contract = json<{ schemaVersion: string; prefixEnvironmentManifestHash: string }>("09_PREPARED_MANIFEST_CONTRACT.json");
    expect(contract.schemaVersion).toBe("direction-a.evo-fresh-n9-prepared-manifest.v3");
    const artifact = { targetPath: N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH, relativePath: "external-prefix-artifacts/usr/local/bin/flowr",
      sha256: "a".repeat(64), requiredExecutable: true as const };
    const build = (withArtifact: boolean) => {
      const built = exact.tasks.map((task, index) => ({ causalGroupId: task.canonicalCausalGroupId, taskId: task.taskId,
        statisticalClusterId: task.statisticalClusterId, officialDomainId: task.officialDomainId, targetRound: task.targetRound,
        sourceMemoryRound: task.targetRound - 1, prefixIndex: task.prefixIndex, taskCandidateHash: task.taskCandidateHash,
        sourceTaskDirectoryHash: task.sourceTaskDirectoryHash, groupCandidateHash: task.groupCandidateHash,
        sourceEvidenceHash: task.sourceEvidenceHash, selectionRole: "FRESH_N9_FIXED" as const, deepReference: false as const,
        validPairMaximum: 4 as const, validPairMinimum: 4 as const, technicalRetryReserveTrials: 2, frozenTotalCases: 111,
        normalTaskPath: "n", fullTaskPath: "f", removeTaskPath: "r", normalTaskDirectoryHash: "e".repeat(64),
        fullTaskDirectoryHash: "f".repeat(64), removeTaskDirectoryHash: "0".repeat(64), frozenPrefixHash: `state_${"1".repeat(24)}`,
        targetGroupHash: "2".repeat(64), recallSnapshotHash: `r0_${"3".repeat(24)}`, guideNormalizationHash: "4".repeat(64),
        normalObservationRole: "CAUSAL_SUPERVISED_SOURCE_X" as const, normalTreatmentAvailability: "SAME_FROZEN_AUTO_INJECTION_AS_FULL" as const,
        normalCountsAsFullReplicate: false as const, normalInstructionHash: "5".repeat(64), fullInstructionHash: "5".repeat(64),
        controlledPreseedScope: "CONDITIONAL_INJECTION_EFFECT_ONLY_NO_NATURAL_WRITE_OR_TRANSPORT_CLAIM" as const,
        technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS" as const,
        preparationArtifactHash: "6".repeat(64),
        pairSchedule: createPairSchedule([1, 2, 3, 4], `final-recovery-test:${task.taskId}`),
        targetInstructionHash: "8".repeat(64), targetTestsDirectoryHash: "9".repeat(64),
        nativeTargetTestsDirectoryHash: "9".repeat(64), preparedTargetTestsDirectoryHash: "9".repeat(64), caseAccounting: null,
        ...(withArtifact && index === 2 ? { externalPrefixArtifacts: [artifact] } : {}) }));
      const body = { schemaVersion: "direction-a.evo-fresh-n9-prepared-manifest.v3" as const, decisionId: exact.decisionId,
        stage: "EVO_FRESH_ENGINEERING_HOLDOUT" as const, runtimeRoot: FRESH_RUNTIME_ROOT, exactManifestHash: exact.contentHash,
        executionProfileHash: "b".repeat(64), denominatorQualificationHash: "c".repeat(64), preparationProtocolHash: "d".repeat(64),
        prefixEnvironmentManifestHash: contract.prefixEnvironmentManifestHash, groups: built, preparedByDriverSha256: "e".repeat(64),
        preparationSemantics: { sourceMemoryRound: "TARGET_ROUND_MINUS_ONE", normalAndFullTreatment: "SAME_FROZEN_AUTO_INJECTION",
          removeTreatment: "NO_MEMORY_CONTEXT", verifier: "EVOCODEBENCH_VERSIONED_COMPLETE_CASE_ACCOUNTING",
          utility: "SUCCESS_COUNT_DIVIDED_BY_FROZEN_TOTAL_CASES", technicalReplacementLimitPerTask: 2, paidProviderCallsDuringPreparation: 0 } };
      return { ...body, contentHash: hashCanonical(body) };
    };
    expect(() => assertFreshPreparedExecutionManifest(build(true) as never, exact)).not.toThrow();
    expect(() => assertFreshPreparedExecutionManifest(build(false) as never, exact)).toThrow("PREFIX_ARTIFACT_BINDING_MISSING");
    const wrongHash = build(true) as { groups: Array<Record<string, unknown>> };
    (wrongHash.groups[2].externalPrefixArtifacts as Array<Record<string, unknown>>)[0].sha256 = "short";
    const wrongBody = { ...wrongHash }; delete (wrongBody as Record<string, unknown>).contentHash;
    expect(() => assertFreshPreparedExecutionManifest({ ...wrongBody, contentHash: hashCanonical(wrongBody) } as never, exact))
      .toThrow("PREFIX_ARTIFACT_BINDING_MISSING");
  });

  it("5. lets the runner continue the historical n3 try-1..3 with exactly one bounded recovery", () => {
    expect(freshBoundedRecoveryIsAvailable(historicalN3, N3_TASK, N3_GROUP, "NORMAL")).toBe(true);
    const recovery: FreshSlotState = { taskId: N3_TASK, causalGroupId: N3_GROUP, arm: "NORMAL", attempt: 1,
      attemptId: N3_PREFIX_ENVIRONMENT_ATTEMPT_ID, status: "PENDING", recoveryId: N3_PREFIX_ENVIRONMENT_RECOVERY_ID };
    expect(nextFreshAction(historicalN3, recovery)).toBe("DISPATCH");
    // The historical slots are never rewritten and never exceed the frozen pool bound.
    expect(() => assertFreshTaskReplacementPool([...historicalN3, recovery])).not.toThrow();
    expect(historicalN3.map((row) => row.attemptId)).toEqual(["fresh-n9-phase1-3-normal-try-1", "fresh-n9-phase1-3-normal-try-2", "fresh-n9-phase1-3-normal-try-3"]);
    // It runs once: a second recovery slot, or a recovery on any other task, is rejected.
    expect(freshBoundedRecoveryIsAvailable([...historicalN3, { ...recovery, status: "RECONCILED" }], N3_TASK, N3_GROUP, "NORMAL")).toBe(false);
    expect(() => assertFreshTaskReplacementPool([...historicalN3, recovery, { ...recovery, status: "RECONCILED" }])).toThrow("BOUNDED_RECOVERY_MAY_RUN_ONCE");
    expect(() => assertFreshTaskReplacementPool([{ ...recovery, taskId: "theme_d11_w2_scientific_numerical_brownfield_modification" }]))
      .toThrow("BOUNDED_RECOVERY_NOT_AUTHORIZED");
    // An ordinary 4th attempt stays structurally impossible.
    expect(() => nextFreshAction(historicalN3, normal(4, "PENDING"))).toThrow();
    // A terminal recovery slot satisfies the barrier exactly once, and a pending arm cannot double-run.
    const terminal: FreshSlotState = { ...recovery, status: "TECHNICAL_INVALID" };
    const afterRecoveryFailure = [...historicalN3, terminal];
    expect(freshBoundedRecoveryIsAvailable(afterRecoveryFailure, N3_TASK, N3_GROUP, "NORMAL")).toBe(false);
    const reconciled: FreshSlotState = { ...recovery, status: "RECONCILED" };
    expect(nextFreshAction([...historicalN3, reconciled], { ...recovery, status: "PENDING" })).toBe("SKIP_RECONCILED");
  });

  it("6. resumes the live run state without re-running n1/n2 and targets n3 first", () => {
    const statePath = resolve(runtimeRoot, "FRESH_N9_RUN_STATE.json");
    if (!existsSync(statePath)) return; // pre-Phase1 environments have no live state yet
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { slots: FreshSlotState[]; tasks: Array<{ taskId: string; canonicalCausalGroupId: string }> };
    const slotMap = new Map(state.slots.map((row) => [row.attemptId, row]));
    expect(slotMap.get("fresh-n9-phase1-1-normal-try-1")?.status).toBe("SCIENTIFIC_FAILURE");
    expect(slotMap.get("fresh-n9-phase1-2-normal-try-1")?.status).toBe("SCIENTIFIC_FAILURE");
    expect(state.slots.filter((row) => row.taskId === "theme_d11_w2_scientific_numerical_brownfield_modification")).toHaveLength(1);
    expect(state.slots.filter((row) => row.taskId === "theme_d10_w4_ml_ai_mlops_migration_upgrade")).toHaveLength(1);
    // The first unfinished task is n3, and its only legal next action is the bounded recovery.
    const n3Slots = state.slots.filter((row) => row.taskId === N3_TASK && row.arm === "NORMAL");
    const reconciled = state.slots.filter((row) => row.status === "RECONCILED" || row.status === "SCIENTIFIC_FAILURE");
    expect(n3Slots.length).toBeGreaterThanOrEqual(3);
    expect(reconciled.some((row) => row.taskId === N3_TASK)).toBe(false);
    expect(freshBoundedRecoveryIsAvailable(n3Slots, N3_TASK, N3_GROUP, "NORMAL") ||
      n3Slots.some((row) => row.status === "DISPATCHED")).toBe(true);
    // No n1/n2 slot is pending, so the runner has nothing to re-dispatch for them.
    expect(state.slots.some((row) => row.status === "PENDING" && row.taskId !== N3_TASK)).toBe(false);
  });

  it("7. keeps Phase1 -> Phase2 -> Phase3 transitions intact for the active prefix", () => {
    const sealed = sealFreshRunState({ schemaVersion: "direction-a.evo-fresh-n9-run-state.v1", phase: "PHASE1_NORMAL", tasks: exact.tasks, slots: historicalN3 });
    expect(sealed.phase).toBe("PHASE1_NORMAL");
    expect(exact.tasks.map((row) => row.prefixIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(exact.protocol.fixedPairCount).toBe(4);
    expect(exact.protocol.task6Forbidden).toBe(true);
    expect(exact.forbiddenTailTaskIds).toHaveLength(4);
  });

  it("8. treats money as telemetry and only stops on a real provider refusal", () => {
    const initial = createFreshInitialBudgetExposure();
    const projected = projectFreshBudgetExposure(initial);
    expect(projected.incrementalProtectedCny).toBe(0);
    expect(projected.remainingIncrementalHeadroomCny).toBeCloseTo(100, 9);
    expect(projected.overDeclaredCap).toBe(false);
    expect(projectFreshBudgetExposure({ ...initial, actualFreshSpendCny: 120 }).overDeclaredCap).toBe(true);
    const admission = reserveFreshWholeTaskBeforeStart(initial, "n3");
    expect(admission.conservativeReserveCny).toBe(FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY);
    expect(admission.coveringBudget).toBe(true);
    expect(admission.budgetRole).toBe("TELEMETRY_ONLY");
    // Admission is reporting only: an under-covered task no longer throws.
    const underCovered = reserveFreshWholeTaskBeforeStart({ ...initial, actualFreshSpendCny: 95 }, "n4");
    expect(underCovered.coveringBudget).toBe(false);
    expect(underCovered.budgetRole).toBe("TELEMETRY_ONLY");
    const telemetry = freshSpendTelemetry([]);
    expect(telemetry.declaredHistoricalSpendCny).toBe(FRESH_HISTORICAL_FRESH_SPEND_CNY);
    expect(FRESH_REMAINING_FRESH_BUDGET_CNY).toBeCloseTo(100 - FRESH_HISTORICAL_FRESH_SPEND_CNY, 9);
    expect(isProviderRefusal("HTTP 402: Insufficient Balance")).toBe(true);
    expect(isProviderRefusal("insufficient_user_quota")).toBe(true);
    expect(isProviderRefusal("Native CASE_SUMMARY invalid for fresh-n9-phase1-3-normal-try-1")).toBe(false);
    expect(isProviderRefusal("Harbor trial failed: flowr binary missing from PATH")).toBe(false);
  });
});
