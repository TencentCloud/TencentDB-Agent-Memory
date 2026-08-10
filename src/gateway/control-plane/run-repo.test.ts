/**
 * tz-09 Ф1 — Run repository.
 *
 * Criterion 9 (`contract-snapshot-pinned`) and the P10 field set live here.
 * The store is a scratch dir; nothing touches ~/.pi/agent-memory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, listRecentRuns, readRun, updateRun } from "./run-repo.js";
import { finishAttempt, listAttempts, recordAttempt } from "./attempt-repo.js";
import { controlPlanePath } from "./db.js";

const NOW = "2026-08-10T20:00:00.000Z";

function input(runId: string, over: Record<string, unknown> = {}) {
  return {
    runId,
    roleId: "memory-keeper",
    contractHash: "hash-v1",
    contractJson: JSON.stringify({ role: "memory-keeper", version: 1 }),
    binding: JSON.stringify({ provider: "p", model: "m" }),
    reason: "manual",
    ...over,
  };
}

describe("control-plane run repository (tz-09 Ф1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cp-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a run in its OWN db, not in vectors.db", () => {
    createRun(dir, input("run-1"), NOW);
    expect(fs.existsSync(controlPlanePath(dir))).toBe(true);
    expect(fs.existsSync(path.join(dir, "vectors.db"))).toBe(false);
  });

  it("carries the whole P10 field set", () => {
    createRun(
      dir,
      input("run-p10", {
        assignmentId: "assign-1",
        roleVersion: "3",
        hostSessionRef: "sess-42",
        inputDigest: "in-abc",
        sessionPath: "/s",
        scratchPath: "/scratch/run-p10",
        logPath: "/logs/x.json",
      }),
      NOW,
    );
    const row = readRun(dir, "run-p10");
    expect(row).not.toBeNull();
    for (const key of [
      "runId",
      "assignmentId",
      "roleId",
      "roleVersion",
      "contractHash",
      "contractJson",
      "binding",
      "hostSessionRef",
      "inputDigest",
      "candidateDigest",
      "verdictDigest",
      "state",
      "fence",
      "leaseOwner",
      "leaseExpiresAt",
      "errorClass",
      "criticReceipt",
      "applyReceipt",
      "sessionPath",
      "scratchPath",
      "logPath",
      "reason",
      "createdAt",
      "updatedAt",
      "finishedAt",
    ]) {
      expect(Object.keys(row as object)).toContain(key);
    }
    expect(row?.state).toBe("created");
    expect(row?.fence).toBe(1);
  });

  // Criterion 9 — contract-snapshot-pinned.
  it("pinned: editing the role contract after creation does not change the run", () => {
    createRun(dir, input("run-pinned"), NOW);
    // A second run of the SAME role with a new contract — the first row keeps
    // the snapshot it was created with.
    createRun(
      dir,
      input("run-later", {
        contractHash: "hash-v2",
        contractJson: JSON.stringify({ role: "memory-keeper", version: 2 }),
      }),
      NOW,
    );
    expect(readRun(dir, "run-pinned")?.contractHash).toBe("hash-v1");
    expect(readRun(dir, "run-later")?.contractHash).toBe("hash-v2");
  });

  it("survives deletion of the scratch dir it points at", () => {
    const scratch = path.join(dir, "scratch", "run-s");
    fs.mkdirSync(scratch, { recursive: true });
    createRun(dir, input("run-s", { scratchPath: scratch }), NOW);
    fs.rmSync(path.join(dir, "scratch"), { recursive: true, force: true });
    expect(readRun(dir, "run-s")?.scratchPath).toBe(scratch);
  });

  it("updateRun patches a known run and refuses an unknown one", () => {
    createRun(dir, input("run-u"), NOW);
    expect(
      updateRun(dir, "run-u", { state: "running" }, "2026-08-10T20:01:00Z"),
    ).toBe(true);
    expect(readRun(dir, "run-u")?.state).toBe("running");
    expect(updateRun(dir, "nope", { state: "running" }, NOW)).toBe(false);
  });

  it("lists recent runs newest first", () => {
    createRun(dir, input("run-old"), "2026-08-10T10:00:00.000Z");
    createRun(dir, input("run-new"), "2026-08-10T12:00:00.000Z");
    expect(listRecentRuns(dir).map((r) => r.runId)).toEqual([
      "run-new",
      "run-old",
    ]);
  });

  it("records launch and critic attempts against a run", () => {
    createRun(dir, input("run-a"), NOW);
    const launch = recordAttempt(dir, "run-a", "launch", NOW);
    finishAttempt(dir, launch, "code", "exit 0", "2026-08-10T20:05:00Z");
    recordAttempt(dir, "run-a", "critic", "2026-08-10T20:06:00Z");
    const attempts = listAttempts(dir, "run-a");
    expect(attempts.map((a) => a.kind)).toEqual(["launch", "critic"]);
    expect(attempts[0]?.outcome).toBe("code");
    expect(attempts[1]?.outcome).toBeNull();
  });
});
