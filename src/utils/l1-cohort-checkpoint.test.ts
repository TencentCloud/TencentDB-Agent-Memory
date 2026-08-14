import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "./checkpoint.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("L1 cohort checkpoint finalizer", () => {
  it("advances cursor and counters exactly once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-l1-checkpoint-"));
    roots.push(root);
    const checkpoint = new CheckpointManager(root);
    const input = {
      cohortId: "cohort-1",
      sessionKey: "agent:test",
      memoriesExtracted: 2,
      cursorRecordedAtMs: 42,
      cursorRecordId: "l0-42",
      lastSceneName: "Preferences",
    };
    expect(await checkpoint.finalizeL1Cohort(input)).toEqual({ isNew: true });
    expect(await checkpoint.finalizeL1Cohort(input)).toEqual({ isNew: false });
    const state = await checkpoint.read();
    expect(state.total_memories_extracted).toBe(2);
    expect(state.memories_since_last_persona).toBe(2);
    expect(state.runner_states[input.sessionKey]).toMatchObject({
      last_l1_cursor: 42,
      last_l1_cursor_id: "l0-42",
      last_l1_finalized_cohort_id: "cohort-1",
      last_scene_name: "Preferences",
    });
  });
});
