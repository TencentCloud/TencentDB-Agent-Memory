import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import type { MemoryRecord } from "./l1-writer.js";
import type { IMemoryStore, L0QueryRow, L0ReplayQuery } from "../store/types.js";
import type { LLMRunner, Logger } from "../types.js";
import {
  L1_REPLAY_RECEIPT_PATH,
  L1ReplayExecutionError,
  replayL1,
} from "./l1-replay.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const rows: L0QueryRow[] = [
  {
    record_id: "m1",
    session_key: "session-retry",
    session_id: "conversation-a",
    role: "user",
    message_text: "Project Atlas has a deployment freeze until Friday.",
    recorded_at: new Date(1_000).toISOString(),
    timestamp: 1_000,
  },
  {
    record_id: "m2",
    session_key: "session-retry",
    session_id: "conversation-a",
    role: "assistant",
    message_text: "I will remember the deployment freeze and its deadline.",
    recorded_at: new Date(2_000).toISOString(),
    timestamp: 2_000,
  },
];

function makeStore(stored: MemoryRecord[]): IMemoryStore {
  return {
    isDegraded: () => false,
    queryL0ForReplay: vi.fn(async (query: L0ReplayQuery) =>
      rows.filter((row) => {
        const recordedAt = Date.parse(row.recorded_at);
        return row.session_key === query.sessionKey &&
          (query.fromRecordedAtMs == null || recordedAt >= query.fromRecordedAtMs) &&
          (query.toRecordedAtMs == null || recordedAt <= query.toRecordedAtMs);
      }).slice(0, query.limit)),
    countL1: () => 0,
    isFtsAvailable: () => false,
    upsertL1: (record: MemoryRecord) => {
      stored.push(record);
      return true;
    },
  } as unknown as IMemoryStore;
}

function makeRunner(run: LLMRunner["run"]): LLMRunner {
  return { run };
}

function makeDeps(baseDir: string, store: IMemoryStore, llmRunner: LLMRunner) {
  return {
    baseDir,
    cfg: parseConfig({
      extraction: {
        enabled: true,
        enableDedup: true,
        maxMemoriesPerSession: 10,
      },
      embedding: { provider: "none" },
    }),
    vectorStore: store,
    llmRunner,
    logger,
  };
}

async function seedCheckpoint(baseDir: string, cursor: number): Promise<void> {
  const checkpoint = new CheckpointManager(baseDir, logger);
  const data = await checkpoint.read();
  checkpoint.getRunnerState(data, "session-retry").last_l1_cursor = cursor;
  await checkpoint.write(data);
}

describe("replayL1", () => {
  it("dry-runs a bounded historical range without invoking the LLM or writing a receipt", async () => {
    const baseDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-l1-replay-dry-"));
    const run = vi.fn<LLMRunner["run"]>();
    try {
      await seedCheckpoint(baseDir, 9_000);
      const store = makeStore([]);
      const receipt = await replayL1({
        sessionKey: "session-retry",
        fromRecordedAtMs: 1_500,
        toRecordedAtMs: 2_500,
        limit: 10,
        dryRun: true,
      }, makeDeps(baseDir, store, makeRunner(run)));

      expect(receipt.status).toBe("dry-run");
      expect(receipt.l0RecordIds).toEqual(["m2"]);
      expect(receipt.attemptedCount).toBe(1);
      expect(receipt.checkpointCursorBefore).toBe(9_000);
      expect(receipt.checkpointCursorAfter).toBe(9_000);
      expect(run).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(baseDir, L1_REPLAY_RECEIPT_PATH))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("preserves L0 lineage, audits success, and skips an exact completed replay", async () => {
    const baseDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-l1-replay-success-"));
    const stored: MemoryRecord[] = [];
    const run = vi.fn<LLMRunner["run"]>().mockResolvedValue(JSON.stringify([{
      scene_name: "Project Atlas deployment",
      message_ids: ["m1", "m2"],
      memories: [{
        content: "Project Atlas has a deployment freeze until Friday.",
        type: "episodic",
        priority: 80,
        source_message_ids: ["m1", "m2"],
        metadata: {},
      }],
    }]));

    try {
      await seedCheckpoint(baseDir, 9_000);
      const store = makeStore(stored);
      const deps = makeDeps(baseDir, store, makeRunner(run));
      const first = await replayL1({
        sessionKey: "session-retry",
        fromRecordedAtMs: 1_000,
        toRecordedAtMs: 2_000,
      }, deps);

      expect(first.status).toBe("completed");
      expect(first.l0RecordIds).toEqual(["m1", "m2"]);
      expect(first.extractedCount).toBe(1);
      expect(first.storedCount).toBe(1);
      expect(first.checkpointCursorAfter).toBe(9_000);
      expect(stored[0]?.source_message_ids).toEqual(["m1", "m2"]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0].prompt).toContain("[m1]");
      expect(run.mock.calls[0]?.[0].prompt).toContain("[m2]");

      const second = await replayL1({
        sessionKey: "session-retry",
        fromRecordedAtMs: 1_000,
        toRecordedAtMs: 2_000,
      }, deps);
      expect(second.status).toBe("skipped");
      expect(second.reusedReceiptId).toBe(first.replayId);
      expect(run).toHaveBeenCalledTimes(1);

      const receipts = (await fs.readFile(path.join(baseDir, L1_REPLAY_RECEIPT_PATH), "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(receipts.map((receipt) => receipt.status)).toEqual(["completed", "skipped"]);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("records failed extraction without advancing the live checkpoint", async () => {
    const baseDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-l1-replay-failure-"));
    const run = vi.fn<LLMRunner["run"]>().mockRejectedValue(new Error("provider unavailable"));
    try {
      await seedCheckpoint(baseDir, 9_000);
      const store = makeStore([]);

      await expect(replayL1({
        sessionKey: "session-retry",
      }, makeDeps(baseDir, store, makeRunner(run)))).rejects.toBeInstanceOf(L1ReplayExecutionError);

      const checkpoint = new CheckpointManager(baseDir, logger);
      const data = await checkpoint.read();
      expect(checkpoint.getRunnerState(data, "session-retry").last_l1_cursor).toBe(9_000);

      const receipt = JSON.parse(
        (await fs.readFile(path.join(baseDir, L1_REPLAY_RECEIPT_PATH), "utf-8")).trim(),
      );
      expect(receipt.status).toBe("failed");
      expect(receipt.error).toContain("L1 extraction failed");
      expect(receipt.checkpointCursorBefore).toBe(9_000);
      expect(receipt.checkpointCursorAfter).toBe(9_000);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
