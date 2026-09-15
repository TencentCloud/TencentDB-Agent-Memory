import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { assertActualArmStartOrderFromJournal, assertPairSchedule, scheduledArms,
  type PairSchedule, type PairStartJournalEvidence } from "../acquisition/integrity.js";

export const T1_PAIR_ORDER_RECOVERY_PURPOSE = "EVO_T1_PAIR_ORDER_INTEGRITY_RECOVERY" as const;
export const T1_PAIR_ORDER_MISMATCH_CLASSIFICATION = "PROTOCOL_PAIR_ORDER_MISMATCH" as const;
export const T1_RECOVERY_RUNTIME_ROOT = "C:\\Users\\L2503\\Desktop\\TencentDB-Agent-Memory\\Direction_A_Evo_T1_PairOrder_Recovery_Runtime_v1" as const;

export interface T1PairOrderAuditGroup {
  officialDomainId: "d6" | "d3";
  taskId: string;
  causalGroupId: string;
  pairSchedule: PairSchedule;
}

export interface T1HistoricalPairAudit {
  officialDomainId: "d6" | "d3";
  taskId: string;
  causalGroupId: string;
  pairIndex: number;
  scheduledArmOrder: "FULL_FIRST" | "REMOVE_FIRST";
  actualFirstStartedArm: "FULL" | "REMOVE";
  actualSecondStartedArm: "FULL" | "REMOVE";
  mismatch: boolean;
  classification: typeof T1_PAIR_ORDER_MISMATCH_CLASSIFICATION | "SCHEDULE_MATCHED_LAWFUL";
  starts: readonly PairStartJournalEvidence[];
}

/** Uses schedule and start-event identity only. No result, reward, score, or causal Y is accepted. */
export function auditT1PairOrder(groups: readonly T1PairOrderAuditGroup[], starts: readonly PairStartJournalEvidence[]): T1HistoricalPairAudit[] {
  return groups.flatMap((group) => {
    assertPairSchedule(group.pairSchedule);
    return [1, 2, 3, 4].map((pairIndex) => {
      const pairStarts = starts.filter((row) => row.taskId === group.taskId && row.causalGroupId === group.causalGroupId && row.pairIndex === pairIndex)
        .sort((a, b) => a.sequence - b.sequence);
      if (pairStarts.length !== 2 || new Set(pairStarts.map((row) => row.arm)).size !== 2) {
        throw new Error(`T1_PAIR_START_PROOF_INCOMPLETE:${group.officialDomainId}:P${pairIndex}`);
      }
      const expected = scheduledArms(group.pairSchedule, pairIndex);
      const actual = pairStarts.map((row) => row.arm) as ["FULL" | "REMOVE", "FULL" | "REMOVE"];
      const mismatch = expected[0] !== actual[0] || expected[1] !== actual[1];
      return immutableCopy({ officialDomainId: group.officialDomainId, taskId: group.taskId,
        causalGroupId: group.causalGroupId, pairIndex,
        scheduledArmOrder: group.pairSchedule.rows.find((row) => row.pairIndex === pairIndex)!.scheduledArmOrder,
        actualFirstStartedArm: actual[0], actualSecondStartedArm: actual[1], mismatch,
        classification: mismatch ? T1_PAIR_ORDER_MISMATCH_CLASSIFICATION : "SCHEDULE_MATCHED_LAWFUL",
        starts: pairStarts });
    });
  });
}

export interface T1PairOrderRecoveryManifest {
  schemaVersion: "direction-a.evo-t1-pair-order-recovery-manifest.v1";
  purpose: typeof T1_PAIR_ORDER_RECOVERY_PURPOSE;
  runtimeRoot: typeof T1_RECOVERY_RUNTIME_ROOT;
  groups: Array<T1PairOrderAuditGroup & { recoveryPairIndices: number[] }>;
  normalTrials: 0;
  baseArmTrials: 8;
  expectedProviderCalls: 96;
  pair5Forbidden: true;
  technicalCompletionAuthority: "RECOVERY_TECHNICAL_COMPLETION_AUTHORITY_REQUIRED_IF_TRIGGERED";
  contentHash: string;
}

export function assertT1PairOrderRecoveryManifest(manifest: T1PairOrderRecoveryManifest): void {
  const { contentHash, ...body } = manifest;
  if (hashCanonical(body) !== contentHash) throw new Error("T1_RECOVERY_MANIFEST_HASH_MISMATCH");
  if (manifest.purpose !== T1_PAIR_ORDER_RECOVERY_PURPOSE || manifest.runtimeRoot !== T1_RECOVERY_RUNTIME_ROOT
    || manifest.normalTrials !== 0 || manifest.baseArmTrials !== 8 || manifest.expectedProviderCalls !== 96 || !manifest.pair5Forbidden) {
    throw new Error("T1_RECOVERY_MANIFEST_SCOPE_MISMATCH");
  }
  const keys = manifest.groups.flatMap((group) => group.recoveryPairIndices.map((pairIndex) => `${group.officialDomainId}:P${pairIndex}`));
  if (hashCanonical(keys.sort()) !== hashCanonical(["d3:P2", "d3:P3", "d6:P2", "d6:P4"])) throw new Error("T1_RECOVERY_MISMATCH_SET_DRIFT");
  manifest.groups.forEach((group) => { assertPairSchedule(group.pairSchedule); group.recoveryPairIndices.forEach((pair) => scheduledArms(group.pairSchedule, pair)); });
}

export function recoverySlots(manifest: T1PairOrderRecoveryManifest): Array<{ taskId: string; causalGroupId: string; pairIndex: number; arm: "FULL" | "REMOVE" }> {
  assertT1PairOrderRecoveryManifest(manifest);
  return manifest.groups.flatMap((group) => group.recoveryPairIndices.flatMap((pairIndex) => scheduledArms(group.pairSchedule, pairIndex)
    .map((arm) => ({ taskId: group.taskId, causalGroupId: group.causalGroupId, pairIndex, arm }))));
}

export function assertRecoveredPairOrder(manifest: T1PairOrderRecoveryManifest, groupId: string, pairIndex: number,
  starts: readonly PairStartJournalEvidence[]): void {
  assertT1PairOrderRecoveryManifest(manifest);
  const group = manifest.groups.find((row) => row.causalGroupId === groupId);
  if (!group || !group.recoveryPairIndices.includes(pairIndex)) throw new Error("T1_RECOVERY_PAIR_NOT_AUTHORIZED");
  assertActualArmStartOrderFromJournal({ schedule: group.pairSchedule, pairIndex, taskId: group.taskId, causalGroupId: group.causalGroupId, starts });
}

