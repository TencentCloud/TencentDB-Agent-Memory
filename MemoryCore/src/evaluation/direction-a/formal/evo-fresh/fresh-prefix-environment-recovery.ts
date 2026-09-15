import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { expectedFreshTasks } from "./fresh-manifest.js";

/** A one-time recovery identity, intentionally outside the ordinary technical replacement pool. */
export const N3_PREFIX_ENVIRONMENT_RECOVERY_ID = "N3_NORMAL_PREFIX_ENVIRONMENT_RECOVERY" as const;
export const N3_PREFIX_ENVIRONMENT_TASK_ID = "theme_d12_w1_automation_productivity_greenfield_implementation" as const;
export const N3_PREFIX_ENVIRONMENT_TASK_PREFIX_INDEX = 3 as const;
export const N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH = "/usr/local/bin/flowr" as const;
export const N3_PREFIX_ENVIRONMENT_SOURCE_ROUNDS = [1, 2, 3, 4, 5, 6] as const;
export const N3_PREFIX_ENVIRONMENT_TARGET_ROUND = 7 as const;
export const N3_PREFIX_ENVIRONMENT_ATTEMPT_ID = "fresh-n9-phase1-3-normal-recovery-1" as const;

export interface N3PrefixEnvironmentEvidenceEntry {
  relativePath: string;
  sha256: string;
}

export interface N3PrefixEnvironmentManifestBody {
  schemaVersion: "direction-a.evo-fresh.n3-prefix-environment-manifest.v1";
  recoveryId: typeof N3_PREFIX_ENVIRONMENT_RECOVERY_ID;
  taskId: string;
  taskPrefixIndex: typeof N3_PREFIX_ENVIRONMENT_TASK_PREFIX_INDEX;
  recoveryAttemptId: typeof N3_PREFIX_ENVIRONMENT_ATTEMPT_ID;
  sourceMemoryRounds: number[];
  targetRound: 7;
  artifact: { targetPath: typeof N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH; requiredExecutable: true; captureMode: "POST_PREFIX_CONTAINER_ALLOWLIST" };
  evidence: N3PrefixEnvironmentEvidenceEntry[];
  targetVerifierRequiresArtifact: true;
  prohibited: { hostFilesystemSnapshot: true; targetRoundSolution: true; verifierModification: true; taskSemanticsModification: true };
}
export type N3PrefixEnvironmentManifest = N3PrefixEnvironmentManifestBody & { contentHash: string };

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const n3Source = (repoRoot: string): string => resolve(repoRoot, ".research/direction-a/v6.3/dependencies/evocodebench_wotraj",
  "theme_d12_w1_automation_productivity_greenfield_implementation");

/**
 * Establishes provenance solely from frozen rounds 1--6 and the unchanged target
 * verifier.  It deliberately records no host binary and never reads round 7's oracle.
 */
export function createN3PrefixEnvironmentManifest(repoRoot: string): N3PrefixEnvironmentManifest {
  const identity = expectedFreshTasks()[2];
  if (!identity || identity.targetRound !== N3_PREFIX_ENVIRONMENT_TARGET_ROUND
    || identity.taskId !== N3_PREFIX_ENVIRONMENT_TASK_ID) {
    throw new Error("CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE");
  }
  const source = n3Source(repoRoot); const evidence: N3PrefixEnvironmentEvidenceEntry[] = [];
  for (const round of N3_PREFIX_ENVIRONMENT_SOURCE_ROUNDS) {
    const path = resolve(source, `steps/round-${round}/solution/solve.sh`);
    if (!existsSync(path) || !readFileSync(path, "utf8").includes("go build -o /usr/local/bin/flowr ./cmd/flowr")) {
      throw new Error(`CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE:round-${round}`);
    }
    evidence.push({ relativePath: relative(repoRoot, path).replaceAll("\\", "/"), sha256: sha256(readFileSync(path)) });
  }
  const verifier = resolve(source, "steps/round-7/tests/test.sh");
  if (!existsSync(verifier) || !readFileSync(verifier, "utf8").includes("command -v flowr")) {
    throw new Error("CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE:target-verifier");
  }
  evidence.push({ relativePath: relative(repoRoot, verifier).replaceAll("\\", "/"), sha256: sha256(readFileSync(verifier)) });
  const body: N3PrefixEnvironmentManifestBody = { schemaVersion: "direction-a.evo-fresh.n3-prefix-environment-manifest.v1",
    recoveryId: N3_PREFIX_ENVIRONMENT_RECOVERY_ID, taskId: identity.taskId,
    taskPrefixIndex: N3_PREFIX_ENVIRONMENT_TASK_PREFIX_INDEX, recoveryAttemptId: N3_PREFIX_ENVIRONMENT_ATTEMPT_ID,
    sourceMemoryRounds: [...N3_PREFIX_ENVIRONMENT_SOURCE_ROUNDS],
    targetRound: 7, artifact: { targetPath: N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH, requiredExecutable: true, captureMode: "POST_PREFIX_CONTAINER_ALLOWLIST" },
    evidence, targetVerifierRequiresArtifact: true,
    prohibited: { hostFilesystemSnapshot: true, targetRoundSolution: true, verifierModification: true, taskSemanticsModification: true } };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) });
}

export function assertN3PrefixEnvironmentManifest(repoRoot: string, value: N3PrefixEnvironmentManifest): void {
  const expected = createN3PrefixEnvironmentManifest(repoRoot); const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || contentHash !== expected.contentHash) {
    throw new Error("CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE");
  }
}
