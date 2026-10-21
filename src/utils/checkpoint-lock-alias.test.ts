import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager path aliases", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(process.cwd(), ".checkpoint-lock-alias-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("serializes mutations addressed through relative and absolute paths", async () => {
    const relativeDataDir = path.relative(process.cwd(), testDir);
    expect(path.isAbsolute(relativeDataDir)).toBe(false);
    expect(path.resolve(relativeDataDir)).toBe(testDir);

    const absolute = new CheckpointManager(testDir);
    const relative = new CheckpointManager(relativeDataDir);

    let notifyFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      notifyFirstEntered = resolve;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstMutation = absolute.captureAtomically(
      "absolute-session",
      undefined,
      async () => {
        notifyFirstEntered();
        await firstMayFinish;
        return { maxTimestamp: 100, messageCount: 1 };
      },
    );
    await firstEntered;

    let notifySecondEntered!: () => void;
    const secondEntered = new Promise<void>((resolve) => {
      notifySecondEntered = resolve;
    });
    const secondMutation = relative.captureAtomically(
      "relative-session",
      undefined,
      async () => {
        notifySecondEntered();
        return { maxTimestamp: 200, messageCount: 1 };
      },
    );

    const bypassedSharedLock = await Promise.race([
      secondEntered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    if (bypassedSharedLock) {
      await secondMutation;
    }

    releaseFirst();
    await Promise.all([firstMutation, secondMutation]);

    expect(bypassedSharedLock).toBe(false);
    const checkpoint = await absolute.read();
    expect(checkpoint.total_processed).toBe(2);
    expect(checkpoint.l0_conversations_count).toBe(2);
    expect(checkpoint.last_captured_timestamp).toBe(200);
    expect(Object.keys(checkpoint.runner_states).sort()).toEqual([
      "absolute-session",
      "relative-session",
    ]);
  });
});
