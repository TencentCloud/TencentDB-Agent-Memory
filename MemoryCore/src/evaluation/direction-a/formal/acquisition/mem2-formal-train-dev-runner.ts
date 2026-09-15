import path from "node:path";
import { hashCanonical, sha256 } from "../core/canonical.js";
import { causalGroupId, causalRowId, statisticalClusterId, type FrozenNormalUnit, type ScientificActionFailureClassification,
  type TechnicalInvalidReason } from "../core/contracts.js";
import type { OnlineMem2ActTask } from "../../online-like.js";
import { renderOnlineMem2ActPrompt } from "../../online-like.js";
import type { Mem2PaidExecutionPermit } from "./mem2-formal-stage-gate.js";
import { assertMem2PaidExecutionPermit } from "./mem2-formal-stage-gate.js";
import { AppendOnlyAttemptJournal } from "./journal.js";
import { createAttemptIntegrityAttestation, createPairSchedule, scheduledArms } from "./integrity.js";
import { RealAcquisitionOrchestrator } from "./orchestrator.js";
import { Mem2ContinuousReferenceRunner } from "./mem2-continuous-reference-runner.js";
import type { TaskAgentExecutionResult } from "./contracts.js";
import type { FrozenArmConfig } from "./contracts.js";
import type { TaskAgentExecutor } from "../executors/task-agent-executor.js";
import type { Mem2ReferenceArm, Mem2ReferencePairSlot } from "../teacher/mem2-continuous-reference.js";
import { MEM2_V71_SYSTEM_PROMPT } from "../executors/mem2-standalone-call.js";

export interface Mem2FormalGroupRunResult {
  componentId: string;
  normal: { attemptId: string; rawArtifactHash: string; observedUsageCostCny: number | null };
  referenceContentHash: string;
  referenceAvailable: boolean;
  firstFourValidPairIndices: number[];
  providerCalls: number;
  unknownUsageCalls: number;
  observedUsageCostCny: number;
}

function normalUnit(task: OnlineMem2ActTask, protocolHash: string,reusedNormalArtifactHash?:string): FrozenNormalUnit {
  return {
    schemaVersion: "direction-a.current-formal.v1",
    causalGroupId: causalGroupId(task.componentId),
    causalRowId: causalRowId(task.qaId),
    statisticalClusterId: statisticalClusterId(task.componentId),
    taskId: task.qaId,
    environmentId: "MEM2ACT",
    permission: reusedNormalArtifactHash?"CAL":"PILOT_TRAIN_DEV",
    protocolHash,
    frozenStateHash: task.taskInputHash,
    recallSnapshotHash: hashCanonical({ sourceConversationIds: task.sourceConversationIds, historyBySource: task.historyBySource }),
    targetSpecHash: hashCanonical(task.targetToolSchema),
    normalArtifactHash: reusedNormalArtifactHash??hashCanonical({ taskInputHash: task.taskInputHash, arm: "NORMAL", independentObservation: true }),
  };
}

function armConfig(task: OnlineMem2ActTask, unit: FrozenNormalUnit, pairIndex: number, arm: "FULL" | "REMOVE"): FrozenArmConfig {
  const included = arm === "FULL" ? task.sourceConversationIds : task.sourceConversationIds.filter((id) => id !== task.targetSourceId);
  return {
    causalGroupId: unit.causalGroupId,
    causalRowId: unit.causalRowId,
    statisticalClusterId: unit.statisticalClusterId,
    pairIndex,
    arm,
    protocolHash: unit.protocolHash,
    frozenStateHash: unit.frozenStateHash,
    targetSpecHash: unit.targetSpecHash,
    promptHash: sha256(renderOnlineMem2ActPrompt(task, included)),
    scaffoldConfigHash: hashCanonical({ systemPrompt: MEM2_V71_SYSTEM_PROMPT, profile: "MEM2_V4PRO_PROFILE_OUTPUT8192_TIMEOUT300_V1" }),
  };
}

export async function runMem2FormalGroups(input: {
  permit: Mem2PaidExecutionPermit;
  executor: TaskAgentExecutor;
  tasks: readonly OnlineMem2ActTask[];
  outputRoot: string;
  authorityBindingHash: string;
  verifierHash: string;
  maximumProviderCalls: number;
  maximumCostCny: number;
  reusedNormalArtifacts?:readonly {componentId:string;attemptId:string;rawArtifactHash:string}[];
}): Promise<Mem2FormalGroupRunResult[]> {
  assertMem2PaidExecutionPermit(input.permit);
  if (input.tasks.some((task) => !task.componentId || !task.qaId) || new Set(input.tasks.map((task) => task.componentId)).size !== input.tasks.length) {
    throw new Error("MEM2_FORMAL_TASK_MANIFEST_INVALID");
  }
  let providerCalls = 0; let observedCost = 0; let unknownUsageCalls = 0;
  const reused=new Map((input.reusedNormalArtifacts??[]).map(row=>[row.componentId,row]));
  if(reused.size!==(input.reusedNormalArtifacts??[]).length
    ||(input.reusedNormalArtifacts&&input.tasks.some(task=>!reused.has(task.componentId))))throw new Error("MEM2_FORMAL_REUSED_NORMAL_BINDING_INVALID");
  const results: Mem2FormalGroupRunResult[] = [];
  const checkStart = (): void => {
    if (providerCalls >= input.maximumProviderCalls || observedCost > input.maximumCostCny) throw new Error("MEM2_FORMAL_CALL_OR_COST_CAP");
  };
  for (const task of input.tasks) {
    const priorNormal=reused.get(task.componentId);
    const unit = normalUnit(task, input.permit.protocolHash,priorNormal?.rawArtifactHash);
    const groupRoot = path.join(input.outputRoot, sha256(task.componentId));
    const journal = new AppendOnlyAttemptJournal(path.join(groupRoot, "journal.jsonl"));
    const orchestrator = new RealAcquisitionOrchestrator(input.executor, journal, path.join(groupRoot, "raw"), input.permit.protocolHash);
    let normal:{attemptId:string;rawArtifactHash:string;result?:TaskAgentExecutionResult};
    let normalCost:number|null=0,normalCalls=0;
    if(priorNormal){normal={attemptId:priorNormal.attemptId,rawArtifactHash:priorNormal.rawArtifactHash};}
    else{checkStart();const acquired=await orchestrator.acquireNormal(unit);normal=acquired;providerCalls+=1;normalCalls=1;
      const observed=acquired.result.technicalMetadata.observedUsageCostCny;
      normalCost=typeof observed==="number"?observed:null;
      if(typeof normalCost==="number")observedCost+=normalCost;else unknownUsageCalls+=1;}
    if (observedCost > input.maximumCostCny) throw new Error("MEM2_FORMAL_OBSERVED_COST_CAP_HOLD");
    const pairSchedule = createPairSchedule([1, 2, 3, 4, 5], hashCanonical({ request: input.permit.requestHash, componentId: task.componentId }));
    await orchestrator.freezePairSchedule(pairSchedule);
    const acquireSlot = async (pairIndex: 1 | 2 | 3 | 4 | 5): Promise<Mem2ReferencePairSlot> => {
      const arms = {} as Record<"FULL" | "REMOVE", Mem2ReferenceArm>;
      for (const [ordinal, arm] of scheduledArms(pairSchedule, pairIndex).entries()) {
        const pairId = `${task.componentId}:pair-${pairIndex}`;
        const recoveredValid = await orchestrator.recoverValidAttempt(pairId, arm);
        if (recoveredValid) {
          const metadata = recoveredValid.result.technicalMetadata;
          const failure = metadata.scientificActionFailure as ScientificActionFailureClassification | undefined;
          arms[arm] = { arm, observation: "SCIENTIFICALLY_OBSERVED", utility: Number(metadata.utility),
            strictPass: metadata.strictPass === true, attemptId: recoveredValid.attemptId,
            rawCompletionHash: String(metadata.rawCompletionHash), outcomeHash: recoveredValid.outcomeHash,
            ...(failure ? { scientificActionFailure: failure } : {}) };
          continue;
        }
        const recoveredTechnical = await orchestrator.recoverTechnicalInvalidAttempt(pairId, arm);
        if (recoveredTechnical) {
          arms[arm] = { arm, observation: "TECHNICAL_INVALID", technicalReason: recoveredTechnical.technicalReason,
            attemptId: recoveredTechnical.attemptId };
          continue;
        }
        checkStart();
        const config = armConfig(task, unit, pairIndex, arm);
        try {
          const acquired = await orchestrator.acquire(unit, config);
          providerCalls += 1;
          const metadata = acquired.result.technicalMetadata;
          const cost = metadata.observedUsageCostCny;
          if (typeof cost === "number") observedCost += cost; else unknownUsageCalls += 1;
          const attestation = createAttemptIntegrityAttestation({
            schemaVersion: "direction-a.attempt-integrity-attestation.v1",
            attemptId: acquired.attemptId,
            restoredStateHash: unit.frozenStateHash,
            frozenStateHash: unit.frozenStateHash,
            environmentSignatureHash: task.taskInputHash,
            taskId: task.qaId,
            roundId: `MEM2_FORMAL_PAIR_${pairIndex}`,
            causalGroupId: task.componentId,
            targetSpecHash: unit.targetSpecHash,
            arm,
            pairScheduleHash: pairSchedule.scheduleHash,
            scheduledArmOrder: pairSchedule.rows.find((row) => row.pairIndex === pairIndex)!.scheduledArmOrder,
            actualArmStartOrdinal: (ordinal + 1) as 1 | 2,
            designBindingHash: input.authorityBindingHash,
            q6SealHash: "NOT_APPLICABLE_MEM2_FORMAL_TRAIN_DEV",
            authorizationHash: input.permit.authorizationHash,
            executionProfileHash: input.permit.profileHash,
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
            scaffoldId: "STANDALONE_ONE_SHOT",
            decodingProfileId: "provider_default_chat_completions",
            horizonId: "MAX_OUTPUT_TOKENS_8192_TIMEOUT_300000",
            verifierId: "mem2",
            verifierVersion: "1A.v1",
            accessPolicyId: "CONDITIONAL_INJECTION_EFFECT",
            guideNormalizationHash: hashCanonical(MEM2_V71_SYSTEM_PROMPT),
            workspaceIsolationHash: hashCanonical({ outputRoot: groupRoot, componentId: task.componentId }),
            contextIsolationPass: true,
          });
          await orchestrator.recordIntegrityAttestation(attestation);
          const failure = metadata.scientificActionFailure as ScientificActionFailureClassification | undefined;
          const outcomeHash = String(metadata.outcomeHash);
          await orchestrator.recordAttemptValidity({ attemptId: acquired.attemptId, pairId,
            arm, valid: true, outcomeHash, ...(failure ? { scientificActionFailure: failure } : {}) });
          arms[arm] = { arm, observation: "SCIENTIFICALLY_OBSERVED", utility: Number(metadata.utility),
            strictPass: metadata.strictPass === true, attemptId: acquired.attemptId,
            rawCompletionHash: String(metadata.rawCompletionHash), outcomeHash, ...(failure ? { scientificActionFailure: failure } : {}) };
        } catch (error) {
          const reason = (error as { reason?: TechnicalInvalidReason }).reason;
          const attemptId = (error as { attemptId?: string }).attemptId;
          if (!reason || !attemptId) throw error;
          providerCalls += 1;
          unknownUsageCalls += 1;
          arms[arm] = { arm, observation: "TECHNICAL_INVALID", technicalReason: reason, attemptId };
        }
        if (observedCost > input.maximumCostCny) throw new Error("MEM2_FORMAL_OBSERVED_COST_CAP_HOLD");
      }
      const pairId = `${task.componentId}:pair-${pairIndex}`;
      if (arms.FULL.observation === "SCIENTIFICALLY_OBSERVED" && arms.REMOVE.observation === "SCIENTIFICALLY_OBSERVED"
        && !await orchestrator.isPairCommitted(pairId)) await orchestrator.commitPair(pairId);
      return { pairId, pairIndex, full: arms.FULL, remove: arms.REMOVE };
    };
    const referenceRunner = new Mem2ContinuousReferenceRunner({ journal, artifactRoot: path.join(groupRoot, "reference"),
      authorityBindingHash: input.authorityBindingHash, protocolHash: input.permit.protocolHash,
      profileHash: input.permit.profileHash, snapshotHash: input.permit.snapshotHash, verifierHash: input.verifierHash, pairSchedule });
    const beforeCalls = providerCalls; const beforeUnknown = unknownUsageCalls;
    const reference = await referenceRunner.run({ causalGroupId: task.componentId, statisticalClusterId: task.componentId,
      acquireSlot, recoverStartedSlot: acquireSlot });
    results.push({ componentId: task.componentId,
      normal: { attemptId: normal.attemptId, rawArtifactHash: normal.rawArtifactHash,
        observedUsageCostCny: typeof normalCost === "number" ? normalCost : null },
      referenceContentHash: reference.contentHash, referenceAvailable: reference.referenceAvailable,
      firstFourValidPairIndices: [...reference.firstFourValidPairIndices], providerCalls: normalCalls + (providerCalls - beforeCalls),
      unknownUsageCalls: unknownUsageCalls - beforeUnknown + (normalCalls&&normalCost === null ? 1 : 0),
      observedUsageCostCny: observedCost - results.reduce((sum, row) => sum + row.observedUsageCostCny, 0) });
  }
  return results;
}
