import type { MemoryScope, MemoryType } from "./l1-writer.js";

export interface L1CursorV1 {
  recordedAtMs: number;
  recordId: string;
}

export interface L1WorksetMessageV1 {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface L1WorksetV1 {
  version: 1;
  assignmentId: string;
  sessionKey: string;
  sessionId: string;
  projectId: string;
  cursorStart: L1CursorV1;
  cursorEnd: L1CursorV1;
  previousSceneName?: string;
  messages: L1WorksetMessageV1[];
  inputDigest: string;
}

export type L1CandidateAction = "store" | "update" | "merge" | "skip";

export interface L1CandidateMemoryV1 {
  candidateId: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  priority: number;
  sourceMessageIds: string[];
  metadata: Record<string, unknown>;
  action: L1CandidateAction;
  targetIds: string[];
}

export interface L1CandidateSceneV1 {
  name: string;
  messageIds: string[];
  memories: L1CandidateMemoryV1[];
}

export interface L1CandidateV1 {
  version: 1;
  assignmentId: string;
  inputDigest: string;
  scenes: L1CandidateSceneV1[];
}

export type L1DispatchFailureKind =
  | "busy"
  | "role-disabled"
  | "launch-failed"
  | "invalid-candidate"
  | "critic-rejected"
  | "stale-artifact";

export type L1DispatchResult =
  | {
      ok: true;
      runId: string;
      approvedAttemptId: string;
      candidate: L1CandidateV1;
      criticReceipt: string;
    }
  | { ok: false; kind: L1DispatchFailureKind; message: string };

export interface L1ExtractionDispatcher {
  dispatchExtraction(input: {
    role: string;
    workset: L1WorksetV1;
  }): Promise<L1DispatchResult>;
}
