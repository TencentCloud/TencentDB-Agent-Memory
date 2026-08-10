/**
 * Run/attempt types for the control plane (tz-09 Ф1, P10).
 *
 * A Run is the unit the whole protocol is about: one role, one contract
 * snapshot, one input, one candidate, one apply. Everything a later phase
 * needs to decide "may this artefact still be applied?" is a column here, so
 * the decision never depends on files under a scratch dir the child can edit.
 */

/** Lifecycle. Terminal: applied, cancelled, needs-reconciliation, failed. */
export type RunState =
  | "created"
  | "claimed"
  | "running"
  | "reviewed"
  | "applying"
  | "applied"
  | "cancelled"
  | "needs-reconciliation"
  | "failed";

export type AttemptKind = "launch" | "critic";

export interface RunRow {
  runId: string;
  /** Groups the runs that serve one dispatch decision (P10). */
  assignmentId: string;
  roleId: string;
  roleVersion: string;
  /** Contract PINNED at creation: editing role.json mid-run changes nothing. */
  contractHash: string;
  contractJson: string;
  /** JSON: { host, provider, model, thinking } as resolved at creation. */
  binding: string;
  hostSessionRef: string;
  inputDigest: string;
  candidateDigest: string | null;
  verdictDigest: string | null;
  state: RunState;
  /** Bumped on every takeover; artefacts of a lower fence are refused. */
  fence: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  errorClass: string | null;
  criticReceipt: string | null;
  applyReceipt: string | null;
  sessionPath: string;
  scratchPath: string;
  logPath: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CreateRunInput {
  runId: string;
  roleId: string;
  assignmentId?: string;
  roleVersion?: string;
  contractHash: string;
  contractJson: string;
  binding: string;
  inputDigest?: string;
  hostSessionRef?: string;
  sessionPath?: string;
  scratchPath?: string;
  logPath?: string;
  reason?: string;
}

export interface AttemptRow {
  attemptId: string;
  runId: string;
  kind: AttemptKind;
  outcome: string | null;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What `<scratchDir>/run.json` carries — a COPY for humans and for the
 * artefact fence check; the database row is the truth. */
export interface RunPassport {
  runId: string;
  fence: number;
  owner: string;
  role: string;
  copyOf: "control-plane.db";
}
