import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import type { L1CandidateV1, L1WorksetV1 } from "../../core/record/l1-agent-types.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { IMemoryStore, L1RecordRow } from "../../core/store/types.js";
import { extraKeysOf, listOps } from "../../gateway/control-plane/oplog.js";
import { commitL1Candidate } from "./l1-candidate-commit.js";

let root = "";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("reviewed L1 update commit", () => {
  it("binds before digest, deletes target, and verifies both projections", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "l1-update-"));
    const before = row("target", "Old preference", "before");
    const rows = new Map([[before.record_id, before]]);
    const store = {
      queryL1Records: async () => [...rows.values()],
      getL1ById: async (id: string) => rows.get(id) ?? null,
      deleteL1Batch: async (ids: string[]) => {
        ids.forEach((id) => rows.delete(id));
        return true;
      },
      upsertL1: async (record: MemoryRecord) => {
        rows.set(record.id, row(record.id, record.content, record.updatedAt));
        return true;
      },
    } as unknown as IMemoryStore;
    const workset = worksetFixture();
    const candidate = candidateFixture(workset);
    await commitL1Candidate({
      baseDir: root,
      workset,
      candidate,
      vectorStore: store,
      targetSnapshots: [{
        candidateId: "preference",
        matches: [{
          id: before.record_id,
          content: before.content,
          contentDigest: digestL1Artifact(before.content),
          type: before.type,
          scope: before.scope!,
          projectId: before.project_id!,
          score: 0.99,
          source: "vector",
          timestamp: before.timestamp_str,
          updatedAt: before.updated_time,
          metadata: {},
        }],
        nearDuplicateTargetId: before.record_id,
      }],
      journal: { runId: "run", candidateDigest: digestL1Artifact(candidate) },
    });
    const [op] = listOps(root, "run");
    expect(op).toMatchObject({ state: "verified", action: "update" });
    expect(extraKeysOf(op!)).toEqual(["target"]);
    expect(JSON.parse(op!.beforeDigestJson)).toEqual({
      target: digestL1Artifact(before.content),
    });
    expect(rows.has("target")).toBe(false);
    expect(rows.size).toBe(1);
  });
});

function worksetFixture(): L1WorksetV1 {
  return {
    version: 1,
    assignmentId: "assignment",
    sessionKey: "session",
    sessionId: "turn",
    projectId: "/repo",
    cursorStart: { recordedAtMs: 1, recordId: "m1" },
    cursorEnd: { recordedAtMs: 1, recordId: "m1" },
    messages: [{ id: "m1", role: "user", content: "dark", timestamp: "now" }],
    inputDigest: "a".repeat(64),
  };
}

function candidateFixture(workset: L1WorksetV1): L1CandidateV1 {
  return {
    version: 1,
    assignmentId: workset.assignmentId,
    inputDigest: workset.inputDigest,
    scenes: [{
      name: "preference",
      messageIds: ["m1"],
      memories: [{
        candidateId: "preference",
        content: "The user prefers dark mode.",
        type: "persona",
        scope: "project",
        priority: 80,
        sourceMessageIds: ["m1"],
        metadata: {},
        action: "update",
        targetIds: ["target"],
      }],
    }],
  };
}

function row(id: string, content: string, updatedAt: string): L1RecordRow {
  return {
    record_id: id,
    content,
    type: "persona",
    priority: 80,
    scene_name: "preference",
    session_key: "session",
    session_id: "turn",
    timestamp_str: updatedAt,
    timestamp_start: "",
    timestamp_end: "",
    created_time: "before",
    updated_time: updatedAt,
    metadata_json: "{}",
    project_id: "/repo",
    scope: "project",
  };
}
