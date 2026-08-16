import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner } from "./l1-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import type { RoleLauncher } from "../../gateway/consolidation/launchers/types.js";
import {
  createTestL1Dispatcher,
  invalidOutputLauncher,
} from "../../gateway/l1/l1-dispatch-fixture.js";
import { readMemoryRecords } from "../../core/record/l1-reader.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { IMemoryStore, L1RecordRow } from "../../core/store/types.js";

const SESSION_KEY = "session-1";
const TODAY = new Date().toISOString().slice(0, 10);
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function seedL0(baseDir: string): void {
  const convDir = join(baseDir, "conversations");
  mkdirSync(convDir, { recursive: true });
  const line = JSON.stringify({
    sessionKey: SESSION_KEY,
    sessionId: SESSION_KEY,
    recordedAt: new Date().toISOString(),
    id: "m1",
    role: "user",
    content: "I prefer dark theme in all my editors",
    timestamp: Date.now(),
  });
  writeFileSync(join(convDir, `${TODAY}.jsonl`), `${line}\n`);
}

function makeRunner(baseDir: string, launcherOverride?: RoleLauncher) {
  const rows = new Map<string, L1RecordRow>();
  const now = new Date().toISOString();
  const vectorStore = {
    isDegraded: () => false,
    queryL0GroupedBySessionId: async (_key: string, after?: number) => after ? [] : [{
      sessionId: SESSION_KEY,
      projectId: "",
      messages: [{
        id: "m1", role: "user", content: "I prefer dark theme in all my editors",
        timestamp: Date.now(), recordedAtMs: Date.now(),
      }],
    }],
    getL1ById: async (id: string) => rows.get(id) ?? null,
    upsertL1: async (record: MemoryRecord) => {
      rows.set(record.id, {
        record_id: record.id,
        content: record.content,
        type: record.type,
        priority: record.priority,
        scene_name: record.scene_name,
        session_key: record.sessionKey,
        session_id: record.sessionId,
        timestamp_str: now,
        timestamp_start: now,
        timestamp_end: now,
        created_time: record.createdAt,
        updated_time: record.updatedAt,
        metadata_json: JSON.stringify(record.metadata),
        project_id: record.projectId,
        scope: record.scope,
      });
      return true;
    },
  } as unknown as IMemoryStore;
  return createL1Runner({
    pluginDataDir: baseDir,
    cfg: {
      extraction: { role: "l1-extractor" },
    } as never,
    vectorStore,
    embeddingService: undefined,
    logger,
    dispatcher: createTestL1Dispatcher(baseDir, launcherOverride),
  });
}

describe("agentic l1-runner cursor gate", () => {
  it("does not advance the cursor when the role output is rejected", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1-runner-gate-"));
    try {
      seedL0(baseDir);
      await expect(
        makeRunner(baseDir, invalidOutputLauncher())({ sessionKey: SESSION_KEY }),
      ).rejects.toThrow("did not reach commit");
      const checkpoint = new CheckpointManager(baseDir, logger);
      const cp = await checkpoint.read();
      expect(checkpoint.getRunnerState(cp, SESSION_KEY).last_l1_cursor).toBe(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("commits memory then advances the composite cursor", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1-runner-ok-"));
    try {
      seedL0(baseDir);
      const runner = makeRunner(baseDir);
      expect((await runner({ sessionKey: SESSION_KEY })).processedCount).toBe(
        1,
      );
      const cp = await new CheckpointManager(baseDir, logger).read();
      expect(cp.runner_states[SESSION_KEY]).toMatchObject({
        last_l1_cursor_id: "m1",
        last_l1_finalized_cohort_id: expect.stringMatching(/^l1c_/),
      });
      expect((await runner({ sessionKey: SESSION_KEY })).processedCount).toBe(
        0,
      );
      expect(
        await readMemoryRecords(SESSION_KEY, baseDir, logger),
      ).toHaveLength(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
