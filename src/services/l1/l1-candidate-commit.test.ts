import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import type {
  L1CandidateMemoryV1,
  L1CandidateV1,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { IMemoryStore, L1RecordRow } from "../../core/store/types.js";
import { listOps } from "../../gateway/control-plane/oplog.js";
import { commitL1Candidate } from "./l1-candidate-commit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l1-commit-"));
  roots.push(root);
  const rows = new Map<string, L1RecordRow>();
  const store = {
    queryL1Records: async () => [...rows.values()],
    getL1ById: async (id: string) => rows.get(id) ?? null,
    upsertL1: async (record: MemoryRecord) => {
      rows.set(record.id, toRow(record));
      return true;
    },
    deleteL1Batch: async (ids: string[]) => {
      ids.forEach((id) => rows.delete(id));
      return true;
    },
  } as unknown as IMemoryStore;
  return { root, rows, store };
}

const workset: L1WorksetV1 = {
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

function candidate(memory: L1CandidateMemoryV1): L1CandidateV1 {
  return {
    version: 1,
    assignmentId: workset.assignmentId,
    inputDigest: workset.inputDigest,
    scenes: [{ name: "preference", messageIds: ["m1"], memories: [memory] }],
  };
}

const baseMemory: L1CandidateMemoryV1 = {
  candidateId: "dark",
  content: "The user prefers dark mode.",
  type: "persona",
  scope: "project",
  priority: 80,
  sourceMessageIds: ["m1"],
  metadata: {},
  action: "store",
  targetIds: [],
};

describe("agentic L1 commit", () => {
  it("verifies JSONL and injected retrieval projections before journaling verified", async () => {
    const { root, rows, store } = setup();
    const input = {
      baseDir: root,
      workset,
      candidate: candidate(baseMemory),
      vectorStore: store,
      targetSnapshots: [],
      journal: { runId: "run", candidateDigest: digestL1Artifact(baseMemory) },
    };
    await commitL1Candidate(input);
    expect(listOps(root, "run")).toMatchObject([
      { state: "verified", action: "store", beforeDigestJson: "{}" },
    ]);
    const [id] = rows.keys();
    rows.set(id, { ...rows.get(id)!, content: "divergent projection" });
    await commitL1Candidate(input);
    expect(rows.get(id)?.content).toBe(baseMemory.content);
  });

  it("refuses a reviewed target that changed before the commit lease", async () => {
    const { root, rows, store } = setup();
    const current = toRow({ id: "target", content: "changed" } as MemoryRecord);
    rows.set("target", current);
    const memory = { ...baseMemory, action: "update" as const, targetIds: ["target"] };
    await expect(
      commitL1Candidate({
        baseDir: root,
        workset,
        candidate: candidate(memory),
        vectorStore: store,
        targetSnapshots: [{
          candidateId: "dark",
          matches: [{
            id: "target",
            content: "before",
            contentDigest: digestL1Artifact("before"),
            type: "persona",
            scope: "project",
            projectId: "/repo",
            score: 0.9,
            source: "fts",
            timestamp: "before",
            updatedAt: "before",
            metadata: {},
          }],
        }],
      }),
    ).rejects.toThrow("changed after review");
  });
});

function toRow(record: MemoryRecord): L1RecordRow {
  return {
    record_id: record.id,
    content: record.content,
    type: record.type ?? "persona",
    priority: record.priority ?? 80,
    scene_name: record.scene_name ?? "preference",
    session_key: record.sessionKey ?? "session",
    session_id: record.sessionId ?? "turn",
    timestamp_str: "now",
    timestamp_start: "",
    timestamp_end: "",
    created_time: record.createdAt ?? "before",
    updated_time: record.updatedAt ?? "changed",
    metadata_json: "{}",
    project_id: record.projectId ?? "/repo",
    scope: record.scope ?? "project",
  };
}
