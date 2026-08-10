/**
 * Artefact ingestion guard (tz-09 Ф2).
 *
 * The decision is made against the control-plane row, NEVER against the file
 * the child could edit: `<scratch>/run.json` lives inside the child's own
 * writable scratch, so a passport-driven check is a check the child can
 * delete. What the database knows is who owns the run now — an artefact
 * produced under a lease this process no longer holds is refused even if the
 * passport is gone.
 *
 * The passport, when present, is still cross-checked: it catches an artefact
 * copied in from a DIFFERENT run, which the owner check alone would accept.
 *
 * A run with no control-plane row at all keeps working — that is the
 * pre-Ф1 path, and its hard gate is Ф6, where apply refuses an unknown runId.
 */
import fs from "node:fs";
import path from "node:path";
import { checkArtifactFence } from "../control-plane/fence.js";
import { readRun } from "../control-plane/run-repo.js";
import { runOwnerId } from "../control-plane/owner.js";
import type { OrchestratorContext } from "./context.js";
import type { RunPassport } from "../control-plane/run-types.js";

/** @returns an error string when the artefact must be refused, else null. */
export function rejectStaleArtifact(
  ctx: OrchestratorContext,
  runId: string,
  scratchDir: string,
): string | null {
  const refuse = (reason: string): string => {
    ctx.logger.warn?.(`[run] artefact refused for ${runId}: ${reason}`);
    return reason;
  };

  const row = readRun(ctx.dataDir, runId);
  if (row === null) return null; // pre-Ф1 run (see header)

  const me = runOwnerId(ctx.ownerPid);
  if (row.leaseOwner !== null && row.leaseOwner !== me) {
    return refuse(
      `stale-fence-rejected: run is owned by ${row.leaseOwner}, not ${me}`,
    );
  }

  let passport: RunPassport | null = null;
  try {
    passport = JSON.parse(
      fs.readFileSync(path.join(scratchDir, "run.json"), "utf-8"),
    ) as RunPassport;
  } catch {
    passport = null;
  }
  if (passport !== null && passport.runId !== runId) {
    return refuse(
      `stale-fence-rejected: artefact belongs to run "${passport.runId}", ` +
        `this run is "${runId}"`,
    );
  }

  // Fence from the ROW when the passport is absent or tampered with: the
  // check then still enforces the run's state, and cannot be turned off by
  // removing a file.
  const check = checkArtifactFence(
    ctx.dataDir,
    runId,
    passport?.fence ?? row.fence,
  );
  if (!check.ok) return refuse(check.reason ?? "stale-fence-rejected");
  return null;
}
