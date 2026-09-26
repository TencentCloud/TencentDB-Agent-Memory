/** Restore the previous index when a process stopped during a refresh. */

import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { IKnowledgeStore } from "./store/types.js";

type RecoveryStore = Pick<IKnowledgeStore,
  "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus"
>;

export function recoverInterruptedCodeGraphs(
  store: RecoveryStore,
  dataDir: string,
  logger?: { warn: (message: string) => void },
): number {
  let recovered = 0;
  for (const row of store.listRecoverableCodeGraphs()) {
    const dir = join(dataDir, row.service_id, row.team_id, row.code_graph_id);
    const previousDir = `${dir}.previous`;
    try {
      // An ordinary failed build has no trustworthy prior snapshot. Only a
      // retained backup proves that an interrupted promotion can be rolled back.
      if (row.status === "failed" && !existsSync(previousDir)) continue;
      // Only an interrupted promotion makes .previous the authoritative
      // last-good snapshot. A stale backup from an already committed build
      // must not replace the canonical directory on a later pending retry.
      if (existsSync(previousDir)) {
        if (row.status === "failed" || row.internal_status === "promoting" || !existsSync(dir)) {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          renameSync(previousDir, dir);
        } else {
          try { rmSync(previousDir, { recursive: true, force: true }); }
          catch (err) { logger?.warn(`[code-graph] could not remove retired index ${row.code_graph_id}: ${String(err)}`); }
        }
      }
      if (!existsSync(join(dir, ".git"))) continue;

      store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
        status: "ready",
        internal_status: null,
        sync_error: "refresh interrupted by restart; previous index retained",
      });
      recovered++;

      // A crash while building can leave large, unused candidate directories.
      try {
        const candidatePrefix = `.${basename(dir)}.candidate-`;
        for (const entry of readdirSync(dirname(dir))) {
          if (entry.startsWith(candidatePrefix)) {
            rmSync(join(dirname(dir), entry), { recursive: true, force: true });
          }
        }
      } catch (err) {
        logger?.warn(`[code-graph] could not remove candidate for ${row.code_graph_id}: ${String(err)}`);
      }
    } catch (err) {
      logger?.warn(`[code-graph] could not restore interrupted refresh ${row.code_graph_id}: ${String(err)}`);
      // Leave the row unchanged; the regular sweep handles pending/processing.
    }
  }

  // If metadata was committed before a crash, the new directory is live and
  // only the retired snapshot remains to be removed.
  for (const ref of store.listSyncedCodeGraphs()) {
    const dir = join(dataDir, ref.service_id, ref.team_id, ref.code_graph_id);
    const previousDir = `${dir}.previous`;
    if (!existsSync(dir) || !existsSync(previousDir)) continue;
    try { rmSync(previousDir, { recursive: true, force: true }); }
    catch (err) { logger?.warn(`[code-graph] could not remove retired index ${ref.code_graph_id}: ${String(err)}`); }
  }
  return recovered;
}
