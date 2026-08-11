/**
 * §3.5 layout of one attempt's working directory (tz-02 критерии 4a/4b).
 *
 * One place names these paths, because the pipeline writes them and six
 * SKILL.md mirrors tell the role to read/write them: a second copy of any of
 * these strings is a rename waiting to half-land.
 *
 *   <scratch>/run.json              — passport (written by run-role.ts)
 *   <scratch>/input/workset.json    — what the role was given
 *   <scratch>/presented-diff.md     — the same input as text, for the role
 *   <scratch>/out/result.json       — what the role produced
 *   <scratch>/out/critic.json       — the critic's verdict
 *
 * `diff.json` in the root is the RETIRED result path. It stays readable for
 * the rollback window: a role package (or a mirror on someone's disk) still
 * carrying the old instruction must degrade to "worked, wrote the old file",
 * not to "produced nothing".
 */
import fs from "node:fs";
import path from "node:path";

export const WORKSET_REL = path.join("input", "workset.json");
export const RESULT_REL = path.join("out", "result.json");
export const CRITIC_REL = path.join("out", "critic.json");
/** Retired: the result used to live here, and the INPUT was written here too. */
export const LEGACY_RESULT_REL = "diff.json";
export const PRESENTED_REL = "presented-diff.md";

/** Create the layout's directories. Callers write into them right after. */
export async function ensureAttemptLayout(scratchDir: string): Promise<void> {
  await fs.promises.mkdir(path.join(scratchDir, "input"), { recursive: true });
  await fs.promises.mkdir(path.join(scratchDir, "out"), { recursive: true });
}

export interface Workset {
  runId: string;
  role: string;
  /** L0 record ids the role was shown — the same set as in presented-diff.md. */
  presentedRecordIds: string[];
  /** Checkpoint cursor the input was built from. */
  cursor: string;
  generatedAt: string;
  /** Where the same input lives as text, relative to the attempt dir. */
  presentedDiffPath: string;
}

export async function writeWorkset(
  scratchDir: string,
  workset: Workset,
): Promise<void> {
  await fs.promises.writeFile(
    path.join(scratchDir, WORKSET_REL),
    JSON.stringify(workset, null, 2),
    "utf-8",
  );
}

export interface ResolvedResult {
  path: string;
  /** True when the role wrote the retired path and the fallback took over. */
  legacy: boolean;
}

/**
 * Which file holds this attempt's result.
 *
 * The new path wins whenever it exists — a stale `diff.json` must never
 * outrank a result the role wrote where it was told to. Only when the new
 * path is absent does the retired one answer.
 */
export function resolveResultPath(scratchDir: string): ResolvedResult {
  const fresh = path.join(scratchDir, RESULT_REL);
  if (fs.existsSync(fresh)) return { path: fresh, legacy: false };
  return { path: path.join(scratchDir, LEGACY_RESULT_REL), legacy: true };
}
