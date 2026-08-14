import { describe, expect, it } from "vitest";
import {
  deriveL1AssignmentId,
  deriveL1RecordId,
  digestL1Artifact,
  parseL1Candidate,
} from "./l1-agent-codec.js";
import type { L1WorksetV1 } from "./l1-agent-types.js";

const workset = (): L1WorksetV1 => {
  const base = {
    version: 1 as const,
    assignmentId: "",
    sessionKey: "agent:test",
    sessionId: "session-1",
    projectId: "/repo",
    cursorStart: { recordedAtMs: 1, recordId: "l0-1" },
    cursorEnd: { recordedAtMs: 2, recordId: "l0-2" },
    messages: [
      {
        id: "l0-1",
        role: "user" as const,
        content: "Use dark mode",
        timestamp: "2026-08-14T00:00:00Z",
      },
    ],
  };
  const assignmentId = deriveL1AssignmentId(base);
  return {
    ...base,
    assignmentId,
    inputDigest: digestL1Artifact({ ...base, assignmentId }),
  };
};

function candidate(input: L1WorksetV1): unknown {
  return {
    version: 1,
    assignmentId: input.assignmentId,
    inputDigest: input.inputDigest,
    scenes: [
      {
        name: "Preferences",
        messageIds: ["l0-1"],
        memories: [
          {
            candidateId: "pref-dark",
            content: "The user prefers dark mode.",
            type: "persona",
            scope: "project",
            priority: 70,
            sourceMessageIds: ["l0-1"],
            metadata: {},
            action: "store",
            targetIds: [],
          },
        ],
      },
    ],
  };
}

describe("L1 agent codec", () => {
  it("derives stable assignment and record ids", () => {
    const first = workset();
    const second = workset();
    expect(first.assignmentId).toBe(second.assignmentId);
    expect(deriveL1RecordId(first.assignmentId, "pref-dark")).toBe(
      deriveL1RecordId(second.assignmentId, "pref-dark"),
    );
  });

  it("accepts a candidate bound to the exact workset", () => {
    const input = workset();
    expect(parseL1Candidate(candidate(input), input).scenes).toHaveLength(1);
  });

  it("rejects unknown sources and duplicate candidate ids", () => {
    const input = workset();
    const raw = candidate(input) as { scenes: Array<{ memories: unknown[] }> };
    raw.scenes[0]!.memories.push(raw.scenes[0]!.memories[0]);
    expect(() => parseL1Candidate(raw, input)).toThrow(
      "duplicate candidate id",
    );
  });

  it("rejects targets not presented by the parent", () => {
    const input = workset();
    const raw = candidate(input) as {
      scenes: Array<{
        memories: Array<{ action: string; targetIds: string[] }>;
      }>;
    };
    raw.scenes[0]!.memories[0]!.action = "update";
    raw.scenes[0]!.memories[0]!.targetIds = ["hidden-record"];
    expect(() => parseL1Candidate(raw, input)).toThrow("unknown target id");
  });
});
