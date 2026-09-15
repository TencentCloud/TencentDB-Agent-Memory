import { readFile } from "node:fs/promises";
import { hashCanonical, sha256 } from "../core/canonical.js";
import type { AttemptJournalEvent, ResumeState } from "./contracts.js";
import type { FrozenNormalUnit } from "../core/contracts.js";
import { assertActualArmStartOrder, assertAttemptIntegrityAttestation, assertPairSchedule, type AttemptIntegrityAttestation, type PairSchedule } from "./integrity.js";

export function reconstructResumeState(events: readonly AttemptJournalEvent[], expectedProtocolHash: string): ResumeState {
  let previous: string | "GENESIS" = "GENESIS";
  const startedAttemptIds = new Set<string>(); const validAttemptsByPairArm = new Map<string, string>(); const rawHashByAttempt = new Map<string, string>(); const pairIds = new Set<string>();
  const armConfigByPairArm = new Map<string, string>();
  const frozenNormalUnits = new Map<string, FrozenNormalUnit>();
  const attestationByAttempt = new Map<string, AttemptIntegrityAttestation>();
  const actualStartsByPair = new Map<string, Array<"FULL" | "REMOVE">>();
  let pairSchedule: PairSchedule | undefined;
  events.forEach((event, index) => {
    if (event.sequence !== index + 1 || event.previousEventHash !== previous || event.protocolHash !== expectedProtocolHash) throw new Error("Attempt journal sequence/protocol/hash-chain drift");
    const { eventHash, ...body } = event; if (hashCanonical(body) !== eventHash) throw new Error(`Attempt journal event hash corruption at ${event.sequence}`);
    previous = event.eventHash;
    if (event.eventType === "NORMAL_FROZEN") {
      const unit = event.payload.normalUnit as unknown as FrozenNormalUnit; const key = String(unit?.causalGroupId); const prior = frozenNormalUnits.get(key);
      if (!unit || unit.protocolHash !== expectedProtocolHash || (prior && hashCanonical(prior) !== hashCanonical(unit))) throw new Error(`Frozen normal unit drift for ${key}`);
      frozenNormalUnits.set(key, structuredClone(unit));
    }
    if (event.eventType === "PAIR_SCHEDULE_FROZEN") {
      const candidate = event.payload.pairSchedule as unknown as PairSchedule;
      assertPairSchedule(candidate);
      if (pairSchedule && pairSchedule.scheduleHash !== candidate.scheduleHash) throw new Error("PairSchedule drift across resume");
      pairSchedule = structuredClone(candidate);
    }
    if (event.eventType === "ATTEMPT_STARTED") {
      if (!event.attemptId || startedAttemptIds.has(event.attemptId)) throw new Error("Attempt IDs must be unique per new Agent call");
      const key = `${event.pairId}\0${event.arm}`; const priorConfig = armConfigByPairArm.get(key);
      if (!event.armConfigHash || (priorConfig && priorConfig !== event.armConfigHash)) throw new Error(`Arm config drift for ${event.pairId}/${event.arm}`);
      armConfigByPairArm.set(key, event.armConfigHash); startedAttemptIds.add(event.attemptId);
      if (pairSchedule) {
        const pairIndex = Number(event.payload.pairIndex);
        if (!Number.isInteger(pairIndex) || !event.pairId || !event.arm) throw new Error("Scheduled attempt start lacks pair identity");
        const starts = [...(actualStartsByPair.get(event.pairId) ?? []), event.arm];
        assertActualArmStartOrder(pairSchedule, pairIndex, starts);
        actualStartsByPair.set(event.pairId, starts);
      }
    }
    if (event.eventType === "ATTEMPT_INTEGRITY_ATTESTED") {
      if (!event.attemptId || !startedAttemptIds.has(event.attemptId)) throw new Error("Integrity attestation has no started attempt");
      const attestation = event.payload.attestation as unknown as AttemptIntegrityAttestation;
      assertAttemptIntegrityAttestation(attestation, { attemptId: event.attemptId, arm: event.arm });
      if (pairSchedule && attestation.pairScheduleHash !== pairSchedule.scheduleHash) throw new Error("INTEGRITY_INVALID:PAIR_SCHEDULE_HASH_MISMATCH");
      if (attestationByAttempt.has(event.attemptId)) throw new Error(`Duplicate integrity attestation ${event.attemptId}`);
      attestationByAttempt.set(event.attemptId, structuredClone(attestation));
    }
    if (event.eventType === "RAW_BOUND") {
      if (!event.attemptId || !startedAttemptIds.has(event.attemptId) || !event.rawArtifactHash) throw new Error("Raw binding has no started attempt");
      const prior = rawHashByAttempt.get(event.attemptId);
      if (prior) throw new Error(prior === event.rawArtifactHash ? `Duplicate raw binding ${event.attemptId}` : `Raw binding drift ${event.attemptId}`);
      rawHashByAttempt.set(event.attemptId, event.rawArtifactHash);
    }
    if (event.eventType === "ATTEMPT_VALID" || event.eventType === "ATTEMPT_SCIENTIFIC_ACTION_FAILURE") { const pairId = String(event.pairId); const key = `${pairId}\0${event.arm}`;
      if (pairSchedule && (!event.attemptId || !attestationByAttempt.has(event.attemptId))) throw new Error("V2 scheduled attempts require integrity attestation before causal outcome");
      if (validAttemptsByPairArm.has(key)) throw new Error(`Duplicate valid arm ${pairId}/${event.arm}`); validAttemptsByPairArm.set(key, String(event.attemptId)); }
    if (event.eventType === "PAIR_COMMITTED") {
      if (!event.pairId || !validAttemptsByPairArm.has(`${event.pairId}\0FULL`) || !validAttemptsByPairArm.has(`${event.pairId}\0REMOVE`)) throw new Error("Committed pair requires exactly one valid FULL and REMOVE");
      if (pairIds.has(event.pairId)) throw new Error(`Duplicate pair commit ${event.pairId}`); pairIds.add(event.pairId);
    }
  });
  return { events: [...events], nextSequence: events.length + 1, startedAttemptIds, validAttemptsByPairArm, rawHashByAttempt, pairIds, frozenNormalUnits,
    pairSchedule, attestationByAttempt, actualStartsByPair };
}

export async function verifyRawArtifact(path: string, expectedHash: string): Promise<void> {
  const actual = sha256(await readFile(path)); if (actual !== expectedHash) throw new Error(`Raw artifact hash corruption: expected ${expectedHash}, received ${actual}`);
}
