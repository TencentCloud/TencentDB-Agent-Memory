import {
  deriveL1AssignmentId,
  digestL1Artifact,
} from "../../core/record/l1-agent-codec.js";
import type {
  L1CursorV1,
  L1WorksetMessageV1,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";
import type { L0SessionGroup } from "../../core/store/types.js";
import { createL1Cohort } from "./l1-cohort-repo.js";

export function persistL1Cohort(input: {
  dataDir: string;
  sessionKey: string;
  cursorStart: L1CursorV1;
  groups: L0SessionGroup[];
  roleContractHash: string;
  previousSceneName?: string;
  nowIso: string;
}): string {
  const rows = input.groups
    .flatMap((group) =>
      group.messages.map((message) => ({
        ...message,
        sessionId: group.sessionId,
        projectId: group.projectId ?? "",
      })),
    )
    .sort(
      (left, right) =>
        left.recordedAtMs - right.recordedAtMs ||
        left.id.localeCompare(right.id),
    );
  const cohortEnd = cursorOf(rows.at(-1));
  const assignments = input.groups.map((group) => {
    const messages: L1WorksetMessageV1[] = group.messages.map((message) => ({
      id: message.id,
      role: message.role as "user" | "assistant",
      content: message.content,
      timestamp: new Date(message.timestamp).toISOString(),
    }));
    const cursorEnd = cursorOf(
      [...group.messages]
        .sort(
          (left, right) =>
            left.recordedAtMs - right.recordedAtMs ||
            left.id.localeCompare(right.id),
        )
        .at(-1),
    );
    const identity = {
      sessionKey: input.sessionKey,
      sessionId: group.sessionId,
      projectId: group.projectId ?? "",
      cursorStart: input.cursorStart,
      cursorEnd,
      messages,
    };
    const assignmentId = deriveL1AssignmentId(identity);
    const unsigned = {
      version: 1 as const,
      assignmentId,
      ...identity,
      previousSceneName: input.previousSceneName,
    };
    const workset: L1WorksetV1 = {
      ...unsigned,
      inputDigest: digestL1Artifact(unsigned),
    };
    return { roleContractHash: input.roleContractHash, workset };
  });
  const rowManifest = rows.map((row) => ({
    recordId: row.id,
    digest: digestL1Artifact(row),
  }));
  const cohortId = `l1c_${digestL1Artifact({
    sessionKey: input.sessionKey,
    cursorStart: input.cursorStart,
    cursorEnd: cohortEnd,
    rowManifest,
  })}`;
  createL1Cohort(
    input.dataDir,
    {
      cohortId,
      sessionKey: input.sessionKey,
      cursorStart: input.cursorStart,
      cursorEnd: cohortEnd,
      rowManifest,
      assignments,
    },
    input.nowIso,
  );
  return cohortId;
}

function cursorOf(
  row: { recordedAtMs: number; id: string } | undefined,
): L1CursorV1 {
  if (!row) throw new Error("cannot create an empty L1 cohort");
  return { recordedAtMs: row.recordedAtMs, recordId: row.id };
}
