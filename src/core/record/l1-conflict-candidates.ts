import type { L1CandidateMemoryV1 } from "./l1-agent-types.js";

export interface L1ConflictCandidate {
  id: string;
  content: string;
  contentDigest: string;
  type: string;
  scope: string;
  projectId: string;
  score: number;
  source: "vector" | "fts";
  timestamp: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface L1ConflictSnapshot {
  candidateId: string;
  matches: L1ConflictCandidate[];
  nearDuplicateTargetId?: string;
}

export const L1_NEAR_DUP_SCORE = 0.88;

export interface L1ConflictCandidateRepository {
  recall(
    candidate: L1CandidateMemoryV1,
    projectId: string,
  ): Promise<L1ConflictSnapshot>;
}
