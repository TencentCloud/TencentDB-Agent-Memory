import { afterEach, describe, expect, it } from "vitest";
import type {
  HostRunResult,
  RoleLauncher,
} from "../consolidation/launchers/types.js";
import { createTestL1Dispatcher } from "./l1-dispatch-fixture.js";
import {
  createL1TestCohort,
  createL1TestDataDir,
  removeL1TestDataDirs,
} from "./l1-test-fixture.js";

const roots: string[] = [];
afterEach(() => removeL1TestDataDirs(roots));

describe("agentic L1 shutdown", () => {
  it("waits for parent commit work after role handles have settled", async () => {
    const root = createL1TestDataDir(roots);
    const dispatcher = createTestL1Dispatcher(root, "approve");
    let releaseCommit!: () => void;
    let enterCommit!: () => void;
    const entered = new Promise<void>((resolve) => (enterCommit = resolve));
    const blocker = new Promise<void>((resolve) => (releaseCommit = resolve));
    const operation = dispatcher.trackOperation(async () => {
      enterCommit();
      await blocker;
      return "committed";
    });
    await entered;
    let stopped = false;
    const shutdown = dispatcher.shutdown().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    releaseCommit();
    await shutdown;
    expect(await operation).toBe("committed");
  });

  it("cancels and reaps a running role before shutdown resolves", async () => {
    const root = createL1TestDataDir(roots);
    const workset = createL1TestCohort(root);
    let resolveCompletion!: (result: HostRunResult) => void;
    let announceLaunch!: () => void;
    let wasCancelled = false;
    const launched = new Promise<void>((resolve) => (announceLaunch = resolve));
    const completion = new Promise<HostRunResult>(
      (resolve) => (resolveCompletion = resolve),
    );
    const cancelled: HostRunResult = {
      status: "cancelled",
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    };
    const launcher: RoleLauncher = {
      id: "pi",
      capabilities: new Set(["session", "thinking", "tool-subset"]),
      async launch(input) {
        announceLaunch();
        return {
          ok: true,
          handle: {
            sessionRef: `blocked:${input.attemptId}`,
            completion,
            cancelAndWait: async () => {
              wasCancelled = true;
              resolveCompletion(cancelled);
              return await completion;
            },
          },
        };
      },
    };
    const dispatcher = createTestL1Dispatcher(root, "approve", launcher);
    const dispatch = dispatcher.dispatchExtraction({
      role: "l1-extractor",
      workset,
    });
    await launched;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await dispatcher.shutdown();
    expect(wasCancelled).toBe(true);
    expect(await dispatch).toMatchObject({ ok: false, kind: "launch-failed" });
    expect(
      await dispatcher.dispatchExtraction({ role: "l1-extractor", workset }),
    ).toMatchObject({ ok: false, kind: "busy" });
  });
});
