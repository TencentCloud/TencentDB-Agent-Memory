/**
 * tz-09 Ф2 — the fence where it matters: artefact ingestion.
 *
 * `preApply` calls this right after `readScratchDiff`, so a child whose
 * attempt was taken over or cancelled cannot get its diff into apply.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rejectStaleArtifact } from "./artifact-fence.js";
import { createRun } from "../control-plane/run-repo.js";
import { cancelRun, claimRun } from "../control-plane/lease.js";
import { runOwnerId } from "../control-plane/owner.js";
import type { OrchestratorContext } from "./context.js";
import type { RunPassport } from "../control-plane/run-types.js";

const T0 = 1_700_000_000_000;
const TTL = 60_000;
/** The owner the ingesting process itself would write — see runOwnerId. */
const mine = runOwnerId(process.pid);

describe("artefact fence at ingestion (tz-09 Ф2)", () => {
  let dir: string;
  let scratch: string;
  let ctx: OrchestratorContext;
  let warns: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-af-"));
    scratch = path.join(dir, "scratch");
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    fs.mkdirSync(scratch, { recursive: true });
    warns = [];
    ctx = {
      dataDir: dir,
      ownerPid: process.pid,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m: string) => warns.push(m),
        error: () => undefined,
      },
    } as unknown as OrchestratorContext;
    createRun(
      dir,
      {
        runId: "r1",
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      new Date(T0).toISOString(),
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function passport(over: Partial<RunPassport> = {}): void {
    const p: RunPassport = {
      runId: "r1",
      fence: 1,
      owner: "owner-a",
      role: "memory-keeper",
      copyOf: "control-plane.db",
      ...over,
    };
    fs.writeFileSync(
      path.join(scratch, "run.json"),
      JSON.stringify(p),
      "utf-8",
    );
  }

  it("no passport → allowed (pre-tz-09 runs keep working)", () => {
    expect(rejectStaleArtifact(ctx, "r1", scratch)).toBeNull();
  });

  it("current fence → allowed", () => {
    claimRun(dir, "r1", mine, { nowMs: T0, ttlMs: TTL });
    passport({ fence: 1 });
    expect(rejectStaleArtifact(ctx, "r1", scratch)).toBeNull();
  });

  it("artefact of a taken-over attempt → refused", () => {
    claimRun(dir, "r1", mine, { nowMs: T0, ttlMs: TTL });
    passport({ fence: 1 });
    claimRun(dir, "r1", "owner-b", { nowMs: T0 + TTL + 1, ttlMs: TTL });

    const err = rejectStaleArtifact(ctx, "r1", scratch);
    expect(err).toMatch(/stale-fence-rejected/);
    expect(warns.join("\n")).toMatch(/artefact refused/);
  });

  // The blocker Codex found: the passport lives in the CHILD's scratch dir,
  // so "delete run.json" must not be a way past the fence.
  it("takeover + deleted passport → still refused", () => {
    claimRun(dir, "r1", mine, { nowMs: T0, ttlMs: TTL });
    claimRun(dir, "r1", "owner-b", { nowMs: T0 + TTL + 1, ttlMs: TTL });
    fs.rmSync(path.join(scratch, "run.json"), { force: true });

    expect(rejectStaleArtifact(ctx, "r1", scratch)).toMatch(
      /stale-fence-rejected/,
    );
  });

  it("artefact of a cancelled run → refused", () => {
    claimRun(dir, "r1", mine, { nowMs: T0, ttlMs: TTL });
    passport({ fence: 1 });
    cancelRun(dir, "r1", T0 + 10);
    expect(rejectStaleArtifact(ctx, "r1", scratch)).toMatch(/rejected|cancel/);
  });

  it("passport of a DIFFERENT run → refused", () => {
    passport({ runId: "other-run" });
    expect(rejectStaleArtifact(ctx, "r1", scratch)).toMatch(
      /artefact belongs to run "other-run"/,
    );
  });
});
