import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import { openControlPlane } from "../control-plane/db.js";
import type { CreateL1CohortInput } from "./l1-control-types.js";

type Db = ReturnType<typeof openControlPlane>;

export function insertL1Cohort(
  db: Db,
  input: CreateL1CohortInput,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO l1_cohorts VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    input.cohortId,
    input.sessionKey,
    input.cursorStart.recordedAtMs,
    input.cursorStart.recordId,
    input.cursorEnd.recordedAtMs,
    input.cursorEnd.recordId,
    JSON.stringify(input.rowManifest),
    JSON.stringify(
      input.assignments.map(({ workset }) => workset.assignmentId),
    ),
    nowIso,
    nowIso,
  );
}

export function insertL1Assignment(
  db: Db,
  cohortId: string,
  ordinal: number,
  input: CreateL1CohortInput["assignments"][number],
  nowIso: string,
): void {
  const worksetJson = JSON.stringify(input.workset);
  db.prepare(
    `INSERT INTO l1_assignments
     (assignmentId, cohortId, ordinal, roleContractHash, sessionKey, sessionId, projectId,
      worksetJson, worksetDigest, state, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
  ).run(
    input.workset.assignmentId,
    cohortId,
    ordinal,
    input.roleContractHash,
    input.workset.sessionKey,
    input.workset.sessionId,
    input.workset.projectId,
    worksetJson,
    digestL1Artifact(input.workset),
    nowIso,
    nowIso,
  );
}
