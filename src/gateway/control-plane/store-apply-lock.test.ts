/**
 * tz-09 Ф7 — one apply per store, one door into `applying` (criterion 2).
 *
 * The interesting assertion is not "both applies succeeded" but the SHAPE of
 * the interleaving: with the lock, the second apply's first mutation starts
 * only after the first apply's last one finished. A journal of block markers
 * makes that visible — without serialization the markers interleave.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, readRun, updateRun } from "./run-repo.js";
import { beginApplying, finishApplying } from "./applying.js";
import {
  storeApplyLockPath,
  withStoreApplyLock,
} from "../apply-executor/store-lock.js";

const NOW = "2026-08-10T23:00:00.000Z";

describe("store apply lock (tz-09 Ф7)", () => {
  let dir: string;

  function seed(runId: string): void {
    createRun(
      dir,
      {
        runId,
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      NOW,
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-applylock-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("two applies from different roles run in blocks, never interleaved", async () => {
    const journal: string[] = [];
    const work = (tag: string) =>
      withStoreApplyLock(
        dir,
        async () => {
          journal.push(`${tag}:start`);
          await new Promise((r) => setTimeout(r, 20));
          journal.push(`${tag}:mid`);
          await new Promise((r) => setTimeout(r, 20));
          journal.push(`${tag}:end`);
        },
        { pollMs: 5 },
      );

    await Promise.all([work("keeper"), work("night")]);

    expect(journal).toHaveLength(6);
    const first = journal[0]?.split(":")[0];
    expect(journal.slice(0, 3).every((e) => e.startsWith(`${first}:`))).toBe(
      true,
    );
    expect(new Set(journal.slice(3).map((e) => e.split(":")[0])).size).toBe(1);
    // The lock file is released, not leaked.
    expect(fs.existsSync(storeApplyLockPath(dir))).toBe(false);
  });

  it("a held lock is waited for, not stolen", async () => {
    let inner = false;
    await withStoreApplyLock(
      dir,
      async () => {
        expect(fs.existsSync(storeApplyLockPath(dir))).toBe(true);
        await expect(
          withStoreApplyLock(
            dir,
            async () => {
              inner = true;
            },
            { waitMs: 40, pollMs: 5 },
          ),
        ).rejects.toThrow(/holds the store lock/);
      },
      { pollMs: 5 },
    );
    expect(inner).toBe(false);
  });

  it("two handlers on the same run: exactly one enters `applying`", () => {
    seed("r1");
    const a = beginApplying(dir, "r1", NOW);
    const b = beginApplying(dir, "r1", NOW);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(b.reason).toContain("applying");
    expect(readRun(dir, "r1")?.state).toBe("applying");
  });

  it("a terminal run never re-enters `applying`", () => {
    seed("r2");
    updateRun(dir, "r2", { state: "applied" }, NOW);
    expect(beginApplying(dir, "r2", NOW).ok).toBe(false);
    expect(readRun(dir, "r2")?.state).toBe("applied");
  });

  it("finishApplying only moves a run that is applying", () => {
    seed("r3");
    finishApplying(dir, "r3", "applied", NOW);
    expect(readRun(dir, "r3")?.state).toBe("created");

    beginApplying(dir, "r3", NOW);
    finishApplying(dir, "r3", "applied", NOW);
    expect(readRun(dir, "r3")?.state).toBe("applied");
  });
});
