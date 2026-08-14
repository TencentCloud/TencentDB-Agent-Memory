import type {
  L1CursorV1,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";

export type L1CohortState = "open" | "committed";
export type L1AssignmentState =
  "created" | "running" | "reviewed" | "committing" | "committed" | "failed";

export interface L1CohortRow {
  cohortId: string;
  sessionKey: string;
  startRecordedAtMs: number;
  startRecordId: string;
  endRecordedAtMs: number;
  endRecordId: string;
  rowManifestJson: string;
  assignmentIdsJson: string;
  state: L1CohortState;
  createdAt: string;
  updatedAt: string;
}

export interface L1AssignmentRow {
  assignmentId: string;
  cohortId: string;
  ordinal: number;
  runId: string | null;
  roleContractHash: string;
  sessionKey: string;
  sessionId: string;
  projectId: string;
  worksetJson: string;
  worksetDigest: string;
  candidateJson: string | null;
  candidateDigest: string | null;
  criticReceiptDigest: string | null;
  approvedAttemptId: string | null;
  state: L1AssignmentState;
  failureCount: number;
  nextRetryAt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface L1AttemptArtifactRow {
  attemptId: string;
  assignmentId: string;
  runId: string;
  fence: number;
  ordinal: number;
  worksetDigest: string;
  reviewInputJson: string;
  reviewInputDigest: string;
  candidateJson: string;
  candidateDigest: string;
  criticAttemptId: string | null;
  verdictJson: string | null;
  verdictDigest: string | null;
  state: "candidate" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface CreateL1CohortInput {
  cohortId: string;
  sessionKey: string;
  cursorStart: L1CursorV1;
  cursorEnd: L1CursorV1;
  rowManifest: Array<{ recordId: string; digest: string }>;
  assignments: Array<{ roleContractHash: string; workset: L1WorksetV1 }>;
}
