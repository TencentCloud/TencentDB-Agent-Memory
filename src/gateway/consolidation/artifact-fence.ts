/**
 * Artefact ingestion guard (tz-09 Ф2).
 *
 * `<scratch>/run.json` is the passport the orchestrator wrote before the
 * spawn. On ingestion we compare it against the control plane: the run must
 * still exist, still be at that fence, and still be allowed to produce an
 * artefact. A child of a taken-over or cancelled attempt fails here, before
 * its diff reaches apply.
 *
 * Missing passport → allowed. The passport arrives with Ф1 and the runs that
 * predate it (or that run with the control plane unavailable) must keep
 * working; the hard gate is Ф6, where apply refuses an unknown runId.
 */
import fs from "node:fs";
import path from "node:path";
import { checkArtifactFence } from "../control-plane/fence.js";
import type { OrchestratorContext } from "./context.js";
import type { RunPassport } from "../control-plane/run-types.js";

/** @returns an error string when the artefact must be refused, else null. */
export function rejectStaleArtifact(
  ctx: OrchestratorContext,
  runId: string,
  scratchDir: string,
): string | null {
  let passport: RunPassport;
  try {
    passport = JSON.parse(
      fs.readFileSync(path.join(scratchDir, "run.json"), "utf-8"),
    ) as RunPassport;
  } catch {
    return null; // no passport → nothing to compare against (see header)
  }
  if (passport.runId !== runId) {
    return (
      `stale-fence-rejected: artefact belongs to run "${passport.runId}", ` +
      `this run is "${runId}"`
    );
  }
  const check = checkArtifactFence(ctx.dataDir, runId, passport.fence);
  if (!check.ok) {
    ctx.logger.warn?.(`[run] artefact refused for ${runId}: ${check.reason}`);
    return check.reason ?? "stale-fence-rejected";
  }
  return null;
}
