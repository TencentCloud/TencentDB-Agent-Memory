import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { L1CandidateV1, L1WorksetV1 } from "../../core/record/l1-agent-types.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { IMemoryStore } from "../../core/store/types.js";
import { commitL1Candidate } from "./l1-candidate-commit.js";
import { repairL1Vector } from "./l1-record-repair.js";

let root = "";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("agentic L1 strict retrieval writes", () => {
  it("rechecks the lease after embedding and before repair upsert", async () => {
    let isLive = true;
    const upsertL1 = vi.fn(async () => true);
    const record = {
      id: "record", content: "durable", type: "persona", priority: 80,
      scene_name: "scene", source_message_ids: [], metadata: {}, timestamps: [],
      createdAt: "now", updatedAt: "now", sessionKey: "s", sessionId: "t",
    } as MemoryRecord;
    const store = {
      getL1ById: async () => ({ content: "divergent" }),
      upsertL1,
    } as unknown as IMemoryStore;
    await expect(repairL1Vector(
      record,
      store,
      { embed: async () => { isLive = false; return new Float32Array([1]); } } as never,
      () => { if (!isLive) throw new Error("lease lost"); },
    )).rejects.toThrow("lease lost");
    expect(upsertL1).not.toHaveBeenCalled();
  });

  it("propagates a false retrieval upsert", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "l1-strict-"));
    const workset = {
      version: 1,
      assignmentId: "assignment",
      sessionKey: "session",
      sessionId: "turn",
      projectId: "",
      cursorStart: { recordedAtMs: 1, recordId: "m1" },
      cursorEnd: { recordedAtMs: 1, recordId: "m1" },
      messages: [{ id: "m1", role: "user", content: "remember", timestamp: "now" }],
      inputDigest: "a".repeat(64),
    } satisfies L1WorksetV1;
    const candidate = {
      version: 1,
      assignmentId: workset.assignmentId,
      inputDigest: workset.inputDigest,
      scenes: [{
        name: "memory",
        messageIds: ["m1"],
        memories: [{
          candidateId: "one",
          content: "Remember this.",
          type: "instruction",
          scope: "global",
          priority: 70,
          sourceMessageIds: ["m1"],
          metadata: {},
          action: "store",
          targetIds: [],
        }],
      }],
    } satisfies L1CandidateV1;
    const store = {
      queryL1Records: async () => [],
      getL1ById: async () => null,
      upsertL1: async () => false,
    } as unknown as IMemoryStore;
    await expect(
      commitL1Candidate({
        baseDir: root,
        workset,
        candidate,
        vectorStore: store,
        targetSnapshots: [],
      }),
    ).rejects.toThrow("upsert returned false");
  });
});
