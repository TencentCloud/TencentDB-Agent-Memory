import { hashCanonical, immutableCopy } from "../core/canonical.js";

export interface EnvironmentExecutionProfile {
  environmentId: "MEM2_STANDALONE" | "EVOCODEBENCH";
  providerId: "deepseek";
  modelId: "deepseek-v4-pro" | "deepseek/deepseek-v4-pro";
  decodingProfileId: string;
  horizon: { kind: "ONE_SHOT"; maxTurns: 1 } | { kind: "AGENT_TURNS"; maxTurns: number };
  maxOutputTokens: number;
  technicalRetryLimit: number;
  scaffoldId: "STANDALONE_ONE_SHOT" | "HARBOR_TERMINUS_2_PINNED";
  scaffoldVersion: string;
  verifierId: string;
  verifierVersion: string;
  toolEnvironmentVersions: Record<string, string>;
  environmentSignatureHash: string;
  sourceEvidenceHashes: string[];
}

export interface RealExecutionProfile {
  schemaVersion: "direction-a.real-execution-profile.v2";
  experimentProgram: "CURRENT_FORMAL_PILOT";
  authorizationState: "LOCKED_PENDING_IMMUTABLE_AUTHORIZATION";
  environments: { mem2: EnvironmentExecutionProfile; evo: EnvironmentExecutionProfile };
  contentHash: string;
}

export function compileRealExecutionProfile(input: { mem2: EnvironmentExecutionProfile; evo: EnvironmentExecutionProfile }): RealExecutionProfile {
  if (input.mem2.environmentId !== "MEM2_STANDALONE" || input.mem2.modelId !== "deepseek-v4-pro" || input.mem2.scaffoldId !== "STANDALONE_ONE_SHOT" || input.mem2.horizon.kind !== "ONE_SHOT") {
    throw new Error("PROVIDER_MODEL_SCAFFOLD_CONFLICT:Mem2 profile differs from frozen current authority");
  }
  if (input.evo.environmentId !== "EVOCODEBENCH" || input.evo.modelId !== "deepseek/deepseek-v4-pro" || input.evo.scaffoldId !== "HARBOR_TERMINUS_2_PINNED" || input.evo.horizon.kind !== "AGENT_TURNS") {
    throw new Error("PROVIDER_MODEL_SCAFFOLD_CONFLICT:Evo profile differs from frozen current authority");
  }
  for (const profile of [input.mem2, input.evo]) {
    if (profile.providerId !== "deepseek" || !profile.decodingProfileId || !profile.verifierId || !profile.verifierVersion || !profile.environmentSignatureHash || !profile.scaffoldVersion) throw new Error(`Incomplete ${profile.environmentId} execution profile`);
    if (!Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1 || !Number.isInteger(profile.technicalRetryLimit) || profile.technicalRetryLimit < 0) throw new Error(`Invalid ${profile.environmentId} horizon/retry profile`);
    if (!profile.sourceEvidenceHashes.length) throw new Error(`${profile.environmentId} profile lacks current-harness source evidence`);
  }
  const body = { schemaVersion: "direction-a.real-execution-profile.v2" as const, experimentProgram: "CURRENT_FORMAL_PILOT" as const,
    authorizationState: "LOCKED_PENDING_IMMUTABLE_AUTHORIZATION" as const, environments: structuredClone(input) };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as RealExecutionProfile;
}

export function assertRealExecutionProfile(profile: RealExecutionProfile): void {
  const { contentHash, ...body } = profile;
  if (hashCanonical(body) !== contentHash) throw new Error("Real execution profile content hash mismatch");
  compileRealExecutionProfile(profile.environments);
}
