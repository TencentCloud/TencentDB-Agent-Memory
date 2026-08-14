import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import type { L1WorksetV1 } from "../../core/record/l1-agent-types.js";
import { createL1Cohort } from "./l1-cohort-repo.js";

export const L1_TEST_NOW = "2026-08-14T00:00:00.000Z";

export function createL1TestDataDir(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l1-protocol-"));
  roots.push(root);
  return root;
}

export function removeL1TestDataDirs(roots: string[]): void {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
}

export function createL1TestCohort(
  root: string,
  assignmentId = "l1a_test",
  cohortId = "cohort-1",
): L1WorksetV1 {
  const workset = createL1TestWorkset(assignmentId);
  createL1Cohort(
    root,
    {
      cohortId,
      sessionKey: workset.sessionKey,
      cursorStart: workset.cursorStart,
      cursorEnd: workset.cursorEnd,
      rowManifest: [{ recordId: "l0-1", digest: "row-digest" }],
      assignments: [{ roleContractHash: "role-v1", workset }],
    },
    L1_TEST_NOW,
  );
  return workset;
}

export function createL1TestWorkset(assignmentId = "l1a_test"): L1WorksetV1 {
  const input = {
    version: 1 as const,
    assignmentId,
    sessionKey: "agent:test",
    sessionId: "session-1",
    projectId: "/repo",
    cursorStart: { recordedAtMs: 1, recordId: "l0-1" },
    cursorEnd: { recordedAtMs: 2, recordId: "l0-2" },
    messages: [
      {
        id: "l0-1",
        role: "user" as const,
        content: "Remember dark mode",
        timestamp: L1_TEST_NOW,
      },
    ],
  };
  return { ...input, inputDigest: digestL1Artifact(input) };
}
