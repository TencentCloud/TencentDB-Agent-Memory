import { hashCanonical } from "./canonical.js";
import type { ArtifactEnvelope, ExperimentProgram } from "./contracts.js";

const CAUSAL_KEY = /(^|_)(causal_?y|causal_?prevalence|teacher_?status|teacher_?label|graded_?outcome|full_?utility|remove_?utility|proposed_?performance|baseline_?performance|post_?pilot_?winner|cal_?result|test_?result)(_|$)/i;

export interface IntegrityResult { check: string; passed: boolean; detail: string }

export function findCausalLeakagePaths(value: unknown, path = "$", found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((child, index) => findCausalLeakagePaths(child, `${path}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (CAUSAL_KEY.test(key)) found.push(childPath);
    findCausalLeakagePaths(child, childPath, found);
  }
  return [...new Set(found)];
}

export function assertLabelBlindInput(value: unknown): void {
  const paths = findCausalLeakagePaths(value);
  if (paths.length) throw new Error(`Causal outcome leakage detected at ${paths.join(", ")}`);
}

export function auditArtifactBoundary(envelopes: readonly ArtifactEnvelope<unknown>[]): IntegrityResult[] {
  const historicalPromotions = envelopes.filter((envelope) => envelope.experimentProgram === "HISTORICAL_FEASIBILITY_AND_FAILURE_ANALYSIS" && envelope.artifactKind.includes("FORMAL"));
  const pilotFormalPermissions = envelopes.filter((envelope) => envelope.experimentProgram === "CURRENT_FORMAL_PILOT" && envelope.permission !== "PILOT_TRAIN_DEV");
  const invalidPayloadHashes = envelopes.filter((envelope) => hashCanonical(envelope.payload) !== envelope.payloadHash);
  const duplicatedIds = envelopes.map((envelope) => envelope.artifactId).filter((id, index, ids) => ids.indexOf(id) !== index);
  return [
    { check: "historical_not_promoted", passed: historicalPromotions.length === 0, detail: historicalPromotions.map((row) => row.artifactId).join(", ") || "none" },
    { check: "pilot_permission_boundary", passed: pilotFormalPermissions.length === 0, detail: pilotFormalPermissions.map((row) => row.artifactId).join(", ") || "all PILOT_TRAIN_DEV" },
    { check: "payload_hashes", passed: invalidPayloadHashes.length === 0, detail: invalidPayloadHashes.map((row) => row.artifactId).join(", ") || "valid" },
    { check: "artifact_ids_unique", passed: duplicatedIds.length === 0, detail: [...new Set(duplicatedIds)].join(", ") || "unique" },
  ];
}

export function assertProgramTransition(from: ExperimentProgram, to: ExperimentProgram): void {
  if (from !== to) throw new Error(`Experiment program is immutable: ${from} cannot be relabeled as ${to}`);
}
