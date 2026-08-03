/**
 * L1 runner cursor-gate test: when extraction reports success:false
 * (e.g. LLM throw), the L1 cursor must NOT advance — the batch re-presents
 * next cycle instead of being silently lost.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner } from "./l1-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";

const SESSION_KEY = "session-1";
const TODAY = new Date().toISOString().slice(0, 10);

function makeLogger() {
  const noop = () => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

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

describe("l1-runner cursor gate", () => {
  it("does NOT advance last_l1_cursor when extraction fails (LLM throws)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1-runner-gate-"));
    try {
      seedL0(baseDir);

      const runner = createL1Runner({
        pluginDataDir: baseDir,
        cfg: {
          extraction: { enableDedup: false, maxMemoriesPerSession: 10, model: "test" },
          embedding: { conflictRecallTopK: 5, captureTimeoutMs: 5000, timeoutMs: 5000 },
        } as never,
        openclawConfig: {},
        vectorStore: undefined,
        embeddingService: undefined,
        logger: makeLogger(),
        llmRunner: {
          async run() {
            throw new Error("simulated LLM timeout");
          },
        },
      });

      const result = await runner({ sessionKey: SESSION_KEY });
      expect(result.processedCount).toBe(0);

      // Cursor must NOT have advanced — stays at the initial 0.
      const checkpoint = new CheckpointManager(baseDir, makeLogger());
      const cp = await checkpoint.read();
      const state = checkpoint.getRunnerState(cp, SESSION_KEY);
      expect(state.last_l1_cursor).toBe(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("advances cursor on successful extraction", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "l1-runner-ok-"));
    try {
      seedL0(baseDir);

      const runner = createL1Runner({
        pluginDataDir: baseDir,
        cfg: {
          extraction: { enableDedup: false, maxMemoriesPerSession: 10, model: "test" },
          embedding: { conflictRecallTopK: 5, captureTimeoutMs: 5000, timeoutMs: 5000 },
        } as never,
        openclawConfig: {},
        vectorStore: undefined,
        embeddingService: undefined,
        logger: makeLogger(),
        llmRunner: {
          async run() {
            return JSON.stringify([
              {
                scene_name: "scene",
                message_ids: ["m1"],
                memories: [
                  { content: "User prefers dark theme", type: "persona", scope: "project", priority: 50 },
                ],
              },
            ]);
          },
        },
      });

      const result = await runner({ sessionKey: SESSION_KEY });
      expect(result.processedCount).toBe(1);

      const checkpoint = new CheckpointManager(baseDir, makeLogger());
      const cp = await checkpoint.read();
      const state = checkpoint.getRunnerState(cp, SESSION_KEY);
      expect(state.last_l1_cursor).toBeGreaterThan(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
