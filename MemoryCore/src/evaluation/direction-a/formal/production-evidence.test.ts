import { describe, expect, it } from "vitest";
import { sha256 } from "./core/canonical.js";
import {
  attachProductionEquivalenceEvidenceHash,
  productionEquivalenceEvidenceHash,
  verifyProductionEquivalenceArtifact,
} from "./core/production-evidence.js";

const HEAD = "a".repeat(40);
const FILENAME = "production-equivalence-v10.json";

function fixture() {
  const body = {
    schemaVersion: "direction-a.production-equivalence.v7",
    overallStatus: "PRODUCTION_EQUIVALENCE_PASS",
    currentHead: HEAD,
    nested: { z: 3, a: 1 },
    rows: [{ beta: 2, alpha: 1 }],
  };
  const report = attachProductionEquivalenceEvidenceHash(body);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const sidecarText = `${sha256(reportBytes)}  ${FILENAME}\n`;
  return { body, report, reportBytes, sidecarText };
}

describe("production-equivalence canonical evidence binding", () => {
  it("uses exactly the same shared canonical hash in producer and verifier", () => {
    const value = fixture();
    const verified = verifyProductionEquivalenceArtifact({
      reportBytes: value.reportBytes,
      sidecarText: value.sidecarText,
      expectedHead: HEAD,
      expectedFilename: FILENAME,
    });
    expect(value.report.evidenceHash).toBe(productionEquivalenceEvidenceHash(value.body));
    expect(verified.evidenceHash).toBe(value.report.evidenceHash);
    expect(verified.reportSha256).toBe(sha256(value.reportBytes));
  });

  it("is invariant to key insertion order at every object level", () => {
    const first = {
      overallStatus: "PRODUCTION_EQUIVALENCE_PASS",
      currentHead: HEAD,
      nested: { z: 3, a: 1 },
    };
    const second = {
      nested: { a: 1, z: 3 },
      currentHead: HEAD,
      overallStatus: "PRODUCTION_EQUIVALENCE_PASS",
    };
    expect(productionEquivalenceEvidenceHash(first)).toBe(productionEquivalenceEvidenceHash(second));
  });

  it("does not call localeCompare and therefore does not depend on OS locale", () => {
    const original = String.prototype.localeCompare;
    Object.defineProperty(String.prototype, "localeCompare", {
      configurable: true,
      value: () => { throw new Error("localeCompare must not be called"); },
    });
    try {
      expect(() => productionEquivalenceEvidenceHash(fixture().body)).not.toThrow();
    } finally {
      Object.defineProperty(String.prototype, "localeCompare", { configurable: true, value: original });
    }
  });

  it("fails closed when the report body is tampered", () => {
    const value = fixture();
    const tampered = { ...value.report, nested: { z: 4, a: 1 } };
    expect(() => verifyProductionEquivalenceArtifact({
      reportBytes: Buffer.from(`${JSON.stringify(tampered)}\n`),
      sidecarText: value.sidecarText,
      expectedHead: HEAD,
      expectedFilename: FILENAME,
    })).toThrow("PRODUCTION_EQUIVALENCE_CANONICAL_EVIDENCE_HASH_MISMATCH");
  });

  it("fails closed when evidenceHash is tampered", () => {
    const value = fixture();
    const tampered = { ...value.report, evidenceHash: "0".repeat(64) };
    expect(() => verifyProductionEquivalenceArtifact({
      reportBytes: Buffer.from(`${JSON.stringify(tampered)}\n`),
      sidecarText: value.sidecarText,
      expectedHead: HEAD,
      expectedFilename: FILENAME,
    })).toThrow("PRODUCTION_EQUIVALENCE_CANONICAL_EVIDENCE_HASH_MISMATCH");
  });

  it("fails closed when the byte-level sidecar is tampered", () => {
    const value = fixture();
    expect(() => verifyProductionEquivalenceArtifact({
      reportBytes: value.reportBytes,
      sidecarText: `${"0".repeat(64)}  ${FILENAME}\n`,
      expectedHead: HEAD,
      expectedFilename: FILENAME,
    })).toThrow("PRODUCTION_EQUIVALENCE_BYTE_SIDECAR_MISMATCH");
  });
});
