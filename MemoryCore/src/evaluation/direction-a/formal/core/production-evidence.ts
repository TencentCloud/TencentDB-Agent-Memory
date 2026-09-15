import { hashCanonical, sha256 } from "./canonical.js";

export interface ProductionEquivalenceReportBody extends Record<string, unknown> {
  overallStatus: unknown;
  currentHead: unknown;
}

export interface ProductionEquivalenceReport extends ProductionEquivalenceReportBody {
  evidenceHash: string;
}

export function productionEquivalenceEvidenceHash(reportBody: unknown): string {
  return hashCanonical(reportBody);
}

export function attachProductionEquivalenceEvidenceHash<T extends ProductionEquivalenceReportBody>(
  reportBody: T,
): T & { evidenceHash: string } {
  return { ...reportBody, evidenceHash: productionEquivalenceEvidenceHash(reportBody) };
}

export function verifyProductionEquivalenceArtifact(input: {
  reportBytes: Buffer;
  sidecarText: string;
  expectedHead: string;
  expectedFilename: string;
}): { report: ProductionEquivalenceReport; reportSha256: string; evidenceHash: string } {
  const parsed = JSON.parse(input.reportBytes.toString("utf8")) as Record<string, unknown>;
  const { evidenceHash, ...reportBody } = parsed;
  if (typeof evidenceHash !== "string" || productionEquivalenceEvidenceHash(reportBody) !== evidenceHash) {
    throw new Error("PRODUCTION_EQUIVALENCE_CANONICAL_EVIDENCE_HASH_MISMATCH");
  }
  if (parsed.overallStatus !== "PRODUCTION_EQUIVALENCE_PASS" || parsed.currentHead !== input.expectedHead) {
    throw new Error("PRODUCTION_EQUIVALENCE_STATUS_OR_HEAD_MISMATCH");
  }
  const reportSha256 = sha256(input.reportBytes);
  const sidecarFields = input.sidecarText.trim().split(/\s+/);
  if (sidecarFields.length !== 2 || sidecarFields[0] !== reportSha256 || sidecarFields[1] !== input.expectedFilename) {
    throw new Error("PRODUCTION_EQUIVALENCE_BYTE_SIDECAR_MISMATCH");
  }
  return {
    report: parsed as ProductionEquivalenceReport,
    reportSha256,
    evidenceHash,
  };
}
