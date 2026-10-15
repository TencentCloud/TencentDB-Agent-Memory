/**
 * Bug #10 fix verification: captureAtomically no longer deadlocks
 * when the callback calls CheckpointManager methods.
 *
 * Fix: captureAtomically now executes the callback outside the file lock
 * (two-phase: read cursor in lock → execute callback unlocked → update cursor in lock).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CheckpointManager } from "./checkpoint.js";

function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cp-fix-"));
}

describe("Bug #10 fix: captureAtomically no longer deadlocks", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDataDir();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("does NOT deadlock when callback calls markL1ExtractionComplete", async () => {
    const cp = new CheckpointManager(dataDir, { info: () => {} });

    const DEADLOCK_TIMEOUT = 5000;
    let timedOut = false;

    const result = await Promise.race([
      (async () => {
        await cp.captureAtomically(
          "session-1",
          Date.now(),
          async () => {
            // This used to deadlock because the lock was held by captureAtomically
            await cp.markL1ExtractionComplete("session-1", 5, Date.now(), "test-scene");
            return { maxTimestamp: Date.now(), messageCount: 3 };
          },
        );
        return "completed";
      })(),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve("timeout");
        }, DEADLOCK_TIMEOUT);
      }),
    ]);

    expect(timedOut).toBe(false);
    expect(result).toBe("completed");

    // Verify state was persisted
    const state2 = await cp.read();
    const runnerState = cp.getRunnerState(state2, "session-1");
    expect(runnerState.last_captured_timestamp).toBeGreaterThan(0);
  }, 10_000);

  it("captureAtomically works fine when callback does not call CheckpointManager", async () => {
    const cp = new CheckpointManager(dataDir, { info: () => {} });

    let callbackRan = false;
    await cp.captureAtomically(
      "session-2",
      Date.now(),
      async () => {
        callbackRan = true;
        return { maxTimestamp: Date.now(), messageCount: 1 };
      },
    );

    expect(callbackRan).toBe(true);

    // Verify state was persisted
    const state = await cp.read();
    const runnerState = cp.getRunnerState(state, "session-2");
    expect(runnerState.last_captured_timestamp).toBeGreaterThan(0);
  });
});
