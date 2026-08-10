/**
 * tz-09 Ф2 — lease, fence, takeover, cancel.
 *
 * Criterion 11 (`cancel-means-no-late-apply`) and P3/P4/P5 live here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, readRun, updateRun } from "./run-repo.js";
import { cancelRun, claimRun, writeWithFence } from "./lease.js";
import { checkArtifactFence } from "./fence.js";

const T0 = 1_700_000_000_000;
const NOW = new Date(T0).toISOString();
const TTL = 60_000;

describe("control-plane lease + fence (tz-09 Ф2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-lease-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    createRun(
      dir,
      {
        runId: "r1",
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      NOW,
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("two claims → one owner", () => {
    const a = claimRun(dir, "r1", "owner-a", { nowMs: T0, ttlMs: TTL });
    const b = claimRun(dir, "r1", "owner-b", { nowMs: T0 + 10, ttlMs: TTL });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(readRun(dir, "r1")?.leaseOwner).toBe("owner-a");
  });

  it("re-claiming your own lease does NOT bump the fence", () => {
    const a = claimRun(dir, "r1", "owner-a", { nowMs: T0, ttlMs: TTL });
    const again = claimRun(dir, "r1", "owner-a", { nowMs: T0 + 5, ttlMs: TTL });
    expect(again.ok).toBe(true);
    expect(again.ok && again.fence).toBe(a.ok && a.fence);
  });

  it("takeover after the lease expires bumps the fence and refuses the old artefact", () => {
    const a = claimRun(dir, "r1", "owner-a", { nowMs: T0, ttlMs: TTL });
    const oldFence = a.ok ? a.fence : -1;

    const b = claimRun(dir, "r1", "owner-b", {
      nowMs: T0 + TTL + 1,
      ttlMs: TTL,
    });
    expect(b.ok).toBe(true);
    expect(b.ok && b.fence).toBe(oldFence + 1);

    // The dead owner's artefact carries the OLD fence.
    const stale = checkArtifactFence(dir, "r1", oldFence);
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/stale-fence-rejected/);
    // The new owner's artefact is accepted.
    expect(checkArtifactFence(dir, "r1", oldFence + 1).ok).toBe(true);
  });

  it("a stale owner cannot advance the run it lost", () => {
    const a = claimRun(dir, "r1", "owner-a", { nowMs: T0, ttlMs: TTL });
    const oldFence = a.ok ? a.fence : -1;
    claimRun(dir, "r1", "owner-b", { nowMs: T0 + TTL + 1, ttlMs: TTL });

    expect(
      writeWithFence(dir, "r1", "owner-a", oldFence, "reviewed", T0 + TTL + 2),
    ).toBe(false);
    expect(
      writeWithFence(
        dir,
        "r1",
        "owner-b",
        oldFence + 1,
        "reviewed",
        T0 + TTL + 3,
      ),
    ).toBe(true);
  });

  // P5 — a run in `applying` is never handed to a new owner.
  it("applying is never taken over — the run parks in needs-reconciliation", () => {
    claimRun(dir, "r1", "owner-a", { nowMs: T0, ttlMs: TTL });
    updateRun(dir, "r1", { state: "applying" }, NOW);

    const takeover = claimRun(dir, "r1", "owner-b", {
      nowMs: T0 + TTL + 1,
      ttlMs: TTL,
    });
    expect(takeover.ok).toBe(false);
    expect(takeover.reason).toMatch(/needs reconciliation/);
    expect(readRun(dir, "r1")?.state).toBe("needs-reconciliation");
  });

  // Criterion 11 — cancel-means-no-late-apply.
  it("cancel in running: a late artefact of the previous owner is refused", () => {
    const a = claimRun(dir, "r1", "owner-a", {
      nowMs: T0,
      ttlMs: TTL,
      state: "running",
    });
    const fence = a.ok ? a.fence : -1;
    expect(checkArtifactFence(dir, "r1", fence).ok).toBe(true);

    expect(cancelRun(dir, "r1", T0 + 100)).toBe(true);

    const late = checkArtifactFence(dir, "r1", fence);
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/stale-fence-rejected/);
    expect(readRun(dir, "r1")?.state).toBe("cancelled");
  });

  it("an unknown run never yields a valid artefact", () => {
    const check = checkArtifactFence(dir, "nope", 1);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/unknown run/);
  });
});
