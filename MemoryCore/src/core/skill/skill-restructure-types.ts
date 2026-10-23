import type { IdFields } from "./types.js";
import type { SkillResourcePayload } from "./skill-resource-store.js";
import type { RestructureBudgets } from "./restructure/types.js";

export interface SkillPackageCandidate {
  name: string;
  content: string;
  resources: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}

export interface SkillCandidateSubmission extends IdFields {
  request_id: string;
  candidate: SkillPackageCandidate;
  source?: { skill_id: string; expected_version: number };
  force?: boolean;
}

export interface StartSkillRestructureInput extends IdFields {
  request_id: string;
  skill_id: string;
  expected_version: number;
  reason?: string;
}

export type SkillRestructureStatus = "queued" | "running" | "prepared" | "publishing" | "succeeded" | "unchanged" | "rejected" | "conflict" | "failed";

export interface SkillRestructureOutput {
  key: string;
  skill_id: string;
  version: number;
  name: string;
  role: "root" | "child";
  reused: boolean;
}

export interface SkillRestructureOperation {
  operation_id: string;
  status: SkillRestructureStatus;
  source_skill_id: string;
  source_version: number;
  created_at_ms: number;
  updated_at_ms: number;
  attempts: number;
  outputs: SkillRestructureOutput[];
  rationale?: string;
  review_summary?: string;
  error?: { code: string; message: string };
}

export interface SkillRestructureConfig {
  enabled: boolean;
  bodyReviewChars: number;
  packageTextReviewBytes: number;
  resourceReviewCount: number;
  leaseMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  policyVersion: string;
  budgets: Partial<RestructureBudgets>;
}

export const DEFAULT_SKILL_RESTRUCTURE_CONFIG: SkillRestructureConfig = {
  enabled: true,
  bodyReviewChars: 24_000,
  packageTextReviewBytes: 64_000,
  resourceReviewCount: 60,
  leaseMs: 30_000,
  maxAttempts: 2,
  retryDelayMs: 2_000,
  policyVersion: "semantic-restructure-v1",
  budgets: { deadlineMs: 600_000 },
};

export interface SkillDraftBatchInput extends IdFields {
  request_id: string;
  input_hash: string;
}
export interface SkillDraftBatch {
  candidates: SkillCandidateSubmission[];
}

/** Private extraction drafts use this port, never pretend to return live versions. */
export interface SkillDraftPublisher {
  loadDraftBatch(input: SkillDraftBatchInput): Promise<SkillDraftBatch | null>;
  freezeDraftBatch(input: SkillDraftBatchInput & SkillDraftBatch): Promise<SkillDraftBatch>;
  runCandidate(input: SkillCandidateSubmission, signal?: AbortSignal): Promise<SkillRestructureOperation>;
}
