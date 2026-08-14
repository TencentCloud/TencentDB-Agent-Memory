import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roleLockPath } from "../../gateway/consolidation/role-lock.js";
import { withStoreApplyLock } from "../../gateway/apply-executor/store-lock.js";
import { withL1CommitLease } from "./l1-commit-lease.js";

const roots: string[] = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "l1-commit-lease-"));
  roots.push(value);
  return value;
}

describe("L1 commit lease", () => {
  it("shares the writer lock with /memory/apply", async () => {
    const dataDir = root();
    let releaseApply!: () => void;
    let enterApply!: () => void;
    const entered = new Promise<void>((resolve) => (enterApply = resolve));
    const blocker = new Promise<void>((resolve) => (releaseApply = resolve));
    const apply = withStoreApplyLock(dataDir, async () => {
      enterApply();
      await blocker;
    });
    await entered;
    let l1Entered = false;
    const l1 = withL1CommitLease({
      dataDir,
      logger,
      commit: async () => { l1Entered = true; return "l1"; },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(l1Entered).toBe(false);
    releaseApply();
    await apply;
    expect(await l1).toEqual({ ok: true, value: "l1" });
  });

  it("serializes every assignment that writes one data store", async () => {
    const dataDir = root();
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const entered = new Promise<void>((resolve) => (enteredFirst = resolve));
    const blocker = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = withL1CommitLease({
      dataDir,
      logger,
      commit: async () => {
        enteredFirst();
        await blocker;
        return "first";
      },
    });
    await entered;
    let secondEntered = false;
    const second = withL1CommitLease({
      dataDir,
      logger,
      commit: async () => {
        secondEntered = true;
        return "second";
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(secondEntered).toBe(false);
    releaseFirst();
    expect(await first).toEqual({ ok: true, value: "first" });
    expect(await second).toEqual({ ok: true, value: "second" });
  });

  it("fails before mutation after renewal loses ownership", async () => {
    vi.useFakeTimers();
    const dataDir = root();
    let assertOwned!: () => void;
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const entered = new Promise<void>((resolve) => (enteredCommit = resolve));
    const blocker = new Promise<void>((resolve) => (releaseCommit = resolve));
    const running = withL1CommitLease({
      dataDir,
      logger,
      commit: async (assertLease) => {
        assertOwned = assertLease;
        enteredCommit();
        await blocker;
        assertLease();
        return "never";
      },
    });
    await entered;
    fs.writeFileSync(
      roleLockPath(dataDir, "_store-apply"),
      JSON.stringify({ token: "stolen", pid: process.pid }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(assertOwned).toThrow("store apply lease expired");
    releaseCommit();
    await expect(running).rejects.toThrow("store apply lease expired");
  });
});
