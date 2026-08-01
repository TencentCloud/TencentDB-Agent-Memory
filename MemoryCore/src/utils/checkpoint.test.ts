import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager.patchPipelineState", () => {
  it("creates a complete state for a new pipeline key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    try {
      const manager = new CheckpointManager(dir);
      await manager.patchPipelineState("profile:team:T1|session:S1", {
        last_extraction_updated_time: "2026-08-01T00:00:00.000Z",
        l2_pending_l1_count: 0,
      });

      const state = (await manager.read()).pipeline_states["profile:team:T1|session:S1"];
      expect(state).toEqual({
        conversation_count: 0,
        last_extraction_time: "",
        last_extraction_updated_time: "2026-08-01T00:00:00.000Z",
        last_active_time: 0,
        l2_pending_l1_count: 0,
        warmup_threshold: 0,
        l2_last_extraction_time: "",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
