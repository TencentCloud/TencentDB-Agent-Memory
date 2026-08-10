/**
 * tz-09 Ф6 — run identity + policy from the repository (criterion 1, P6).
 *
 * The point of these tests is what the caller CANNOT do: apply without a run,
 * apply against a run that is over, widen its own ops/caps by passing a
 * friendlier policy alongside the body, or — the blocker Codex found — apply a
 * diff no critic ever approved.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, updateRun } from "../control-plane/run-repo.js";
import { resolveRunPolicy } from "./run-policy.js";
import { digestOf } from "./op-journal.js";
import { ApplyValidationError } from "./errors.js";
import type { ApplyOp } from "./schemas.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";

const NOW = "2026-08-10T22:00:00.000Z";
const POLICY = {
  policy: {
    opsSubset: ["rewriteBlock"],
    caps: { deletePerRun: 1, rewritePerRun: 2 },
  },
};

describe("run policy (tz-09 Ф6)", () => {
  let dir: string;
  let warns: string[];

  function depsWith(runRepo: boolean): ApplyExecutorDeps {
    return {
      dataDir: dir,
      runRepo,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m: string) => warns.push(m),
        error: () => undefined,
      },
    } as unknown as ApplyExecutorDeps;
  }

  function seedRun(runId: string, contract: unknown): void {
    createRun(
      dir,
      {
        runId,
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: JSON.stringify(contract),
        binding: "{}",
      },
      NOW,
    );
  }

  /** A run that a critic approved for exactly `candidate`. */
  function seedApproved(runId: string, candidate: unknown): void {
    seedRun(runId, POLICY);
    updateRun(
      dir,
      runId,
      {
        state: "reviewed",
        candidateDigest: digestOf(JSON.stringify(candidate)),
        verdictDigest: "v",
        criticReceipt: '{"verdict":"approve"}',
      },
      NOW,
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-runpolicy-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    warns = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runRepo off is the rollback: the caller's context passes through", () => {
    const run = {
      runId: "whatever",
      caps: { deletePerRun: 9, rewritePerRun: 9 },
    };
    expect(resolveRunPolicy(depsWith(false), run, {})).toBe(run);
    expect(resolveRunPolicy(depsWith(false), undefined, {})).toBeUndefined();
  });

  it("no runId → refused before any mutation", () => {
    expect(() => resolveRunPolicy(depsWith(true), undefined, {})).toThrow(
      ApplyValidationError,
    );
    expect(() => resolveRunPolicy(depsWith(true), { runId: "" }, {})).toThrow(
      /runId/,
    );
  });

  it("unknown runId → refused", () => {
    expect(() =>
      resolveRunPolicy(depsWith(true), { runId: "ghost" }, {}),
    ).toThrow(/no control-plane record/);
  });

  it.each(["applied", "cancelled", "failed", "needs-reconciliation"] as const)(
    "a run in %s can no longer apply",
    (state) => {
      seedRun("r1", {});
      updateRun(dir, "r1", { state }, NOW);
      expect(() =>
        resolveRunPolicy(depsWith(true), { runId: "r1" }, {}),
      ).toThrow(new RegExp(state));
    },
  );

  it("the snapshot's policy overrides a wider one from the caller", () => {
    const candidate = { rewriteBlock: [] };
    seedApproved("r2", candidate);
    const scoped = resolveRunPolicy(
      depsWith(true),
      {
        runId: "r2",
        opsSubset: new Set<ApplyOp>(["deleteL1", "merge"]),
        caps: { deletePerRun: 999, rewritePerRun: 999 },
        gateMode: "enforce",
      },
      candidate,
    );
    expect([...(scoped?.opsSubset ?? [])]).toEqual(["rewriteBlock"]);
    expect(scoped?.caps).toEqual({ deletePerRun: 1, rewritePerRun: 2 });
  });

  it("a snapshot without a policy leaves the caller's in force (shadow)", () => {
    seedRun("r3", { name: "memory-keeper" });
    const scoped = resolveRunPolicy(
      depsWith(true),
      { runId: "r3", opsSubset: new Set<ApplyOp>(["merge"]) },
      {},
    );
    expect([...(scoped?.opsSubset ?? [])]).toEqual(["merge"]);
  });

  it("a snapshot without a policy is refused in enforce", () => {
    const candidate = { rewriteBlock: [] };
    seedRun("r4", { name: "memory-keeper" });
    updateRun(
      dir,
      "r4",
      {
        state: "reviewed",
        candidateDigest: digestOf(JSON.stringify(candidate)),
        verdictDigest: "v",
        criticReceipt: "{}",
      },
      NOW,
    );
    expect(() =>
      resolveRunPolicy(
        depsWith(true),
        { runId: "r4", gateMode: "enforce" },
        candidate,
      ),
    ).toThrow(/pinned no ops\/caps policy/);
  });

  it("a diff no critic approved is refused in enforce", () => {
    const approved = { rewriteBlock: [{ path: "a.md", content: "ok" }] };
    seedApproved("r5", approved);
    expect(() =>
      resolveRunPolicy(
        depsWith(true),
        { runId: "r5", gateMode: "enforce" },
        { rewriteBlock: [{ path: "a.md", content: "SWAPPED" }] },
      ),
    ).toThrow(/not the approved candidate/);
  });

  it("a run that was never reviewed cannot apply in enforce", () => {
    const candidate = { rewriteBlock: [] };
    seedRun("r6", POLICY);
    updateRun(dir, "r6", { state: "running" }, NOW);
    expect(() =>
      resolveRunPolicy(
        depsWith(true),
        { runId: "r6", gateMode: "enforce" },
        candidate,
      ),
    ).toThrow(/not reviewed by a critic/);
  });

  it("shadow only warns, so the gate can ship dark", () => {
    seedRun("r7", POLICY);
    updateRun(dir, "r7", { state: "running" }, NOW);
    expect(
      resolveRunPolicy(depsWith(true), { runId: "r7" }, { merge: [] }),
    ).toBeDefined();
    expect(warns.join("\n")).toMatch(/candidate gate SHADOW/);
  });

  it("the journal digest comes from the record, not from the caller", () => {
    const candidate = { rewriteBlock: [] };
    seedApproved("r8", candidate);
    const scoped = resolveRunPolicy(
      depsWith(true),
      { runId: "r8", candidateDigest: "caller-chosen", gateMode: "enforce" },
      candidate,
    );
    expect(scoped?.candidateDigest).toBe(digestOf(JSON.stringify(candidate)));
  });
});
