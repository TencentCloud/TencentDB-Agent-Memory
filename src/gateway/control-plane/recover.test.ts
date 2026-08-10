/**
 * tz-09 Ф2 — startup recovery of runs a dead process left live.
 *
 * This is what makes the lease real in production: without it `claimRun` was
 * reachable only from tests, every run kept fence 1, and the artefact-fence
 * check downstream compared 1 with 1 forever.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, readRun, updateRun } from "./run-repo.js";
import { claimRun } from "./lease.js";
import { checkArtifactFence } from "./fence.js";
import { recoverOrphanRuns } from "./recover.js";
import type { RunState } from "./run-types.js";

const NOW = Date.parse("2026-08-10T23:30:00.000Z");
const ME = "this-host:1";
const DEAD = "dead-host:999999";

describe("orphan run recovery (tz-09 Ф2)", () => {
  let dir: string;

  function orphan(runId: string, state: RunState): void {
    const iso = new Date(NOW).toISOString();
    createRun(
      dir,
      {
        runId,
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      iso,
    );
    // A process that is gone held the lease, and its ttl has expired.
    claimRun(dir, runId, DEAD, { nowMs: NOW - 3_600_000, ttlMs: 1 });
    updateRun(dir, runId, { state }, iso);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-recover-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("takes over a running orphan, bumps the fence and ends the run", () => {
    orphan("r-run", "running");
    const fenceBefore = readRun(dir, "r-run")?.fence ?? 0;

    const recovered = recoverOrphanRuns(dir, ME, { nowMs: NOW, ttlMs: 60_000 });

    expect(recovered).toHaveLength(1);
    const row = readRun(dir, "r-run");
    expect(row?.state).toBe("failed");
    expect(row?.errorClass).toBe("orphan-run");
    expect(row?.fence).toBeGreaterThan(fenceBefore);
    // The artefact the dead child is still writing carries the OLD fence.
    expect(checkArtifactFence(dir, "r-run", fenceBefore).ok).toBe(false);
  });

  it("never takes over a run that was applying — it is parked instead", () => {
    orphan("r-applying", "applying");

    recoverOrphanRuns(dir, ME, { nowMs: NOW, ttlMs: 60_000 });

    const row = readRun(dir, "r-applying");
    expect(row?.state).toBe("needs-reconciliation");
    const check = checkArtifactFence(dir, "r-applying", row?.fence ?? 0);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("reconciliation");
  });

  it("leaves this process's own live runs alone", () => {
    const iso = new Date(NOW).toISOString();
    createRun(
      dir,
      {
        runId: "r-mine",
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      iso,
    );
    claimRun(dir, "r-mine", ME, {
      nowMs: NOW,
      ttlMs: 60_000,
      state: "running",
    });

    expect(recoverOrphanRuns(dir, ME, { nowMs: NOW, ttlMs: 60_000 })).toEqual(
      [],
    );
    expect(readRun(dir, "r-mine")?.state).toBe("running");
  });

  it("a finished run cannot ingest an artefact even at a matching fence", () => {
    orphan("r-done", "running");
    recoverOrphanRuns(dir, ME, { nowMs: NOW, ttlMs: 60_000 });
    const row = readRun(dir, "r-done");

    // Same fence as the row itself: only the STATE refuses here.
    const check = checkArtifactFence(dir, "r-done", row?.fence ?? 0);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("failed");
  });
});
