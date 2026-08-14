import type { L1AttemptArtifactRow } from "./l1-control-types.js";

export function hasMatchingL1Receipt(artifact: L1AttemptArtifactRow): boolean {
  if (artifact.verdictJson === null) return false;
  const verdict = JSON.parse(artifact.verdictJson) as Record<string, unknown>;
  return (
    verdict.verdict === "approve" &&
    verdict.candidateDigest === artifact.candidateDigest &&
    verdict.inputDigest === artifact.reviewInputDigest
  );
}
