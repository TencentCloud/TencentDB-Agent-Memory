/**
 * tz-09 Ф6 — run identity + policy from the repository (criterion 1, P6).
 *
 * The point of these tests is what the caller CANNOT do: apply without a run,
 * apply against a run that is over, or widen its own ops/caps by passing a
 * friendlier policy alongside the body.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun, updateRun } from "../control-plane/run-repo.js";
import { resolveRunPolicy } from "./run-policy.js";
import { ApplyValidationError } from "./errors.js";
import type { ApplyOp } from "./schemas.js";

const NOW = "2026-08-10T22:00:00.000Z";

describe("run policy (tz-09 Ф6)", () => {
  let dir: string;

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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-runpolicy-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runRepo off is the rollback: the caller's context passes through", () => {
    const run = {
      runId: "whatever",
      caps: { deletePerRun: 9, rewritePerRun: 9 },
    };
    expect(resolveRunPolicy(dir, run, false)).toBe(run);
    expect(resolveRunPolicy(dir, undefined, false)).toBeUndefined();
  });

  it("no runId → refused before any mutation", () => {
    expect(() => resolveRunPolicy(dir, undefined, true)).toThrow(
      ApplyValidationError,
    );
    expect(() => resolveRunPolicy(dir, { runId: "" }, true)).toThrow(/runId/);
  });

  it("unknown runId → refused", () => {
    expect(() => resolveRunPolicy(dir, { runId: "ghost" }, true)).toThrow(
      /no control-plane record/,
    );
  });

  it.each(["applied", "cancelled", "failed", "needs-reconciliation"] as const)(
    "a run in %s can no longer apply",
    (state) => {
      seedRun("r1", {});
      updateRun(dir, "r1", { state }, NOW);
      expect(() => resolveRunPolicy(dir, { runId: "r1" }, true)).toThrow(
        new RegExp(state),
      );
    },
  );

  it("the snapshot's policy overrides a wider one from the caller", () => {
    seedRun("r2", {
      policy: {
        opsSubset: ["rewriteBlock"],
        caps: { deletePerRun: 1, rewritePerRun: 2 },
      },
    });
    const scoped = resolveRunPolicy(
      dir,
      {
        runId: "r2",
        opsSubset: new Set<ApplyOp>(["deleteL1", "merge"]),
        caps: { deletePerRun: 999, rewritePerRun: 999 },
      },
      true,
    );
    expect([...(scoped?.opsSubset ?? [])]).toEqual(["rewriteBlock"]);
    expect(scoped?.caps).toEqual({ deletePerRun: 1, rewritePerRun: 2 });
  });

  it("a snapshot without a policy leaves the caller's in force", () => {
    seedRun("r3", { name: "memory-keeper" });
    const scoped = resolveRunPolicy(
      dir,
      { runId: "r3", opsSubset: new Set<ApplyOp>(["merge"]) },
      true,
    );
    expect([...(scoped?.opsSubset ?? [])]).toEqual(["merge"]);
  });
});
