/** Restore the previous index when a process stopped during a refresh. */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import Database from "better-sqlite3";

import { isCodeGraphId } from "./store/ids.js";
import type { IKnowledgeStore } from "./store/types.js";

const RESTORING_PREVIOUS = "restoring_previous";
const RESTORING_SUSPECT = "restoring_suspect";
const INVALID_PREVIOUS = "previous_invalid";
const AMBIGUOUS_PREVIOUS = "previous_ambiguous";
const AMBIGUOUS_CANONICAL = "canonical_ambiguous";
const AMBIGUOUS_SUSPECT = "suspect_ambiguous";
const MISSING_CANONICAL = "canonical_missing";
const SUSPECT_RESTORED_ERROR = "uncommitted index replaced after restart; sync required";
const PRE_PROMOTION_PHASES = new Set(["cloning", "copying", "fetching", "indexing"]);
// node:sqlite was introduced after Node 22.0; use the existing dependency on
// older supported runtimes or when the built-in module is not enabled.
const BuiltinDatabaseSync: typeof import("node:sqlite").DatabaseSync | null = (() => {
  try { return (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")).DatabaseSync; }
  catch { return null; }
})();

function hasIndexSnapshot(dir: string): boolean {
  const dbPath = join(dir, ".codegraph", "codegraph.db");
  if (!existsSync(join(dir, ".git")) || !existsSync(dbPath)) return false;
  try {
    if (BuiltinDatabaseSync) {
      const db = new BuiltinDatabaseSync(dbPath, { readOnly: true });
      try { return db.prepare("PRAGMA quick_check(1)").get()?.quick_check === "ok"; }
      finally { db.close(); }
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { return db.pragma("quick_check(1)", { simple: true }) === "ok"; }
    finally { db.close(); }
  } catch { return false; }
}

/** Resolve symbolic and packed refs, and require HEAD to name a real commit. */
export function verifiedCodeGraphHead(dir: string): string | null {
  if (!hasIndexSnapshot(dir)) return null;
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
  } catch { return null; }
}

/** Accept legacy SHA prefixes while new builds persist the full commit SHA. */
function matchesCommittedHead(dir: string, commitHash: string | null): boolean {
  if (!commitHash || !/^[0-9a-f]{7,64}$/i.test(commitHash)) return false;
  return verifiedCodeGraphHead(dir)?.toLowerCase().startsWith(commitHash.toLowerCase()) ?? false;
}

function unavailablePatch(reason: string, phase: string): Parameters<RecoveryStore["updateCodeGraphStatus"]>[2] {
  return {
    status: "failed",
    internal_status: phase,
    has_last_good: false,
    sync_error: reason,
  };
}

function suspectFailurePatch(): Parameters<RecoveryStore["updateCodeGraphStatus"]>[2] {
  return {
    status: "failed",
    internal_status: null,
    has_last_good: false,
    commit_hash: null,
    stats_json: null,
    last_sync_at: null,
    summary: null,
    sync_error: SUSPECT_RESTORED_ERROR,
  };
}

function restoreSuspect(
  store: RecoveryStore,
  serviceId: string,
  codeGraphId: string,
  dir: string,
): void {
  const suspectDir = `${dir}.suspect`;
  store.updateCodeGraphStatus(serviceId, codeGraphId, {
    status: "processing",
    internal_status: RESTORING_SUSPECT,
  });
  if (existsSync(suspectDir)) {
    if (!hasIndexSnapshot(suspectDir)) {
      store.updateCodeGraphStatus(serviceId, codeGraphId,
        unavailablePatch("suspect snapshot is incomplete; manual recovery required", AMBIGUOUS_SUSPECT));
      return;
    }
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    renameSync(suspectDir, dir);
  }
  store.updateCodeGraphStatus(serviceId, codeGraphId, suspectFailurePatch());
}

type RecoveryStore = Pick<IKnowledgeStore,
  "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus" | "getCodeGraph"
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
      // An earlier recovery could not identify the committed snapshot.
      // Preserve every directory until it can be inspected or resynced.
      if (row.internal_status === INVALID_PREVIOUS ||
          row.internal_status === AMBIGUOUS_PREVIOUS ||
          row.internal_status === AMBIGUOUS_CANONICAL ||
          row.internal_status === AMBIGUOUS_SUSPECT) continue;
      if (row.internal_status !== RESTORING_PREVIOUS &&
          (existsSync(`${dir}.suspect`) || row.internal_status === RESTORING_SUSPECT)) {
        // A successful retry may leave a retired .suspect if finalize could
        // not remove it. During the next ordinary promotion, .previous holds
        // the committed snapshot even while canonical is absent or already
        // contains an uncommitted replacement. Never prefer the stale suspect
        // merely because canonical is missing.
        const committedSnapshotExists = row.has_last_good && (
          matchesCommittedHead(dir, row.commit_hash) ||
          matchesCommittedHead(previousDir, row.commit_hash)
        );
        if (committedSnapshotExists) {
          // Let the regular previous/canonical arbitration below select the
          // committed snapshot. The ready-row sweep removes .suspect only
          // after that selection succeeds.
        } else if (row.internal_status === RESTORING_SUSPECT || !row.has_last_good || row.internal_status === "promoting_suspect") {
          restoreSuspect(store, row.service_id, row.code_graph_id, dir);
          continue;
        } else {
          store.updateCodeGraphStatus(row.service_id, row.code_graph_id,
            unavailablePatch("canonical, previous, and suspect snapshots cannot be identified from committed Git HEAD; manual recovery required", AMBIGUOUS_SUSPECT));
          continue;
        }
      }
      // The persisted bit survives a crash and does not depend on a timestamp
      // that older ready rows may lack.
      if (!row.has_last_good) continue;
      const restoringPrevious = row.internal_status === RESTORING_PREVIOUS;
      const canonicalComplete = hasIndexSnapshot(dir);
      const previousExists = existsSync(previousDir);
      const canonicalMatches = matchesCommittedHead(dir, row.commit_hash);
      const previousMatches = matchesCommittedHead(previousDir, row.commit_hash);
      let restorePrevious = restoringPrevious;
      let clearMetadata = restoringPrevious;

      if (!restoringPrevious && previousExists) {
        if (canonicalMatches) {
          // A close failure in `promoting` can happen before its first rename.
          // The backup may therefore be an older, unrelated version.
        } else if (previousMatches && !canonicalMatches) {
          restorePrevious = true;
          clearMetadata = true;
        } else if (PRE_PROMOTION_PHASES.has(row.internal_status ?? "") && canonicalComplete && row.status !== "failed") {
          // These phases cannot rename or mutate canonical. A .previous here
          // was left by an earlier committed refresh and is disposable.
        } else if (!existsSync(dir) && hasIndexSnapshot(previousDir)) {
          restorePrevious = true;
          clearMetadata = true;
        } else if (row.status === "pending" && canonicalComplete) {
          // CAS succeeded but the process stopped before the queued job ran.
        } else {
          const backupIncomplete = !hasIndexSnapshot(previousDir);
          store.updateCodeGraphStatus(row.service_id, row.code_graph_id,
            backupIncomplete
              ? unavailablePatch("previous snapshot is incomplete; manual recovery or resync required", INVALID_PREVIOUS)
              : unavailablePatch("canonical and previous snapshots cannot be identified from committed Git HEAD; manual recovery required", AMBIGUOUS_PREVIOUS));
          continue;
        }
      } else if (!restoringPrevious) {
        if (row.status === "failed" && !canonicalMatches) continue;
        if (!canonicalComplete) continue;
        if (row.internal_status === "promoting" && !canonicalMatches) {
          store.updateCodeGraphStatus(row.service_id, row.code_graph_id,
            unavailablePatch("promoted snapshot has no matching committed Git HEAD; manual recovery required", AMBIGUOUS_PREVIOUS));
          continue;
        }
      }

      if (restorePrevious && previousExists) {
        if (!hasIndexSnapshot(previousDir)) {
          // Never replace canonical with an incomplete backup.
          store.updateCodeGraphStatus(row.service_id, row.code_graph_id,
            unavailablePatch("previous snapshot is incomplete; manual recovery or resync required", INVALID_PREVIOUS));
          continue;
        }
        // Persist intent before removing either directory. If the process
        // stops between rm and rename, the next startup finishes this step.
        store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
          status: "processing", internal_status: RESTORING_PREVIOUS,
        });
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        renameSync(previousDir, dir);
      } else if (previousExists) {
        try { rmSync(previousDir, { recursive: true, force: true }); }
        catch (err) { logger?.warn(`[code-graph] could not remove retired index ${row.code_graph_id}: ${String(err)}`); }
      }
      if (!hasIndexSnapshot(dir)) continue;

      store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
        status: "ready", internal_status: null,
        sync_error: restorePrevious ? "refresh interrupted by restart; previous index restored" : "refresh interrupted by restart; canonical index retained",
        ...(clearMetadata ? {
          commit_hash: null, stats_json: null, last_sync_at: null, summary: null,
        } : {}),
      });
      recovered++;

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
    const suspectDir = `${dir}.suspect`;
    // A valid SQLite file is not enough to prove that the checkout belongs to
    // the committed metadata. Do not discard either backup when Git HEAD
    // disagrees with a recorded commit; an operator can inspect the copies.
    try {
      const row = store.getCodeGraph(ref.service_id, ref.team_id, ref.code_graph_id);
      if (!row) continue;
      if (row.commit_hash && /^[0-9a-f]{7,64}$/i.test(row.commit_hash) &&
          hasIndexSnapshot(dir) && !matchesCommittedHead(dir, row.commit_hash)) {
        store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id,
          unavailablePatch("canonical Git HEAD differs from committed metadata; manual recovery required", AMBIGUOUS_CANONICAL));
        continue;
      }
    } catch (err) {
      logger?.warn(`[code-graph] could not verify committed index ${ref.code_graph_id}: ${String(err)}`);
      continue;
    }
    // The ordinary refresh backup outranks a retired suspect when canonical
    // was lost between renames, or its promoted database is incomplete.
    // Verify the backup's Git commit before choosing between two snapshots.
    const preferPrevious = existsSync(suspectDir) && !hasIndexSnapshot(dir) && existsSync(previousDir);
    if (preferPrevious) {
      try {
        const row = store.getCodeGraph(ref.service_id, ref.team_id, ref.code_graph_id);
        if (!row) continue;
        if (!verifiedCodeGraphHead(previousDir)) {
          store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id,
            unavailablePatch("previous snapshot has no verifiable Git HEAD; manual recovery required", AMBIGUOUS_PREVIOUS));
          continue;
        }
        if (matchesCommittedHead(suspectDir, row.commit_hash) &&
            !matchesCommittedHead(previousDir, row.commit_hash)) {
          store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id,
            unavailablePatch("previous and suspect snapshots disagree with committed Git HEAD; manual recovery required", AMBIGUOUS_SUSPECT));
          continue;
        }
      } catch (err) {
        logger?.warn(`[code-graph] could not verify previous snapshot ${ref.code_graph_id}: ${String(err)}`);
        continue;
      }
    }
    if (existsSync(suspectDir) && !preferPrevious) {
      if (!hasIndexSnapshot(dir)) {
        try { restoreSuspect(store, ref.service_id, ref.code_graph_id, dir); }
        catch (err) { logger?.warn(`[code-graph] could not restore missing or incomplete committed index from suspect ${ref.code_graph_id}: ${String(err)}`); }
        continue;
      }
      try { rmSync(suspectDir, { recursive: true, force: true }); }
      catch (err) { logger?.warn(`[code-graph] could not remove retired suspect ${ref.code_graph_id}: ${String(err)}`); }
    }
    if (!existsSync(previousDir)) {
      if (!hasIndexSnapshot(dir)) {
        try {
          store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id,
            unavailablePatch("committed index is missing or incomplete; resync required", MISSING_CANONICAL));
        } catch (err) {
          logger?.warn(`[code-graph] could not mark missing committed index ${ref.code_graph_id}: ${String(err)}`);
        }
      }
      continue;
    }
    if (!hasIndexSnapshot(dir)) {
      if (!hasIndexSnapshot(previousDir)) {
        try {
          store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id, {
            status: "failed",
            internal_status: INVALID_PREVIOUS,
            has_last_good: false,
            sync_error: "committed index missing and previous snapshot is incomplete",
          });
        } catch (err) {
          logger?.warn(`[code-graph] could not mark incomplete previous snapshot ${ref.code_graph_id}: ${String(err)}`);
        }
        continue;
      }
      try {
        // Persist recovery intent before the rename. A crash after either step
        // is completed by the recoverable-row pass on the next startup.
        store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id, {
          status: "processing",
          internal_status: RESTORING_PREVIOUS,
        });
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        renameSync(previousDir, dir);
        store.updateCodeGraphStatus(ref.service_id, ref.code_graph_id, {
          status: "ready",
          internal_status: null,
          sync_error: "committed index missing after restart; previous snapshot restored",
          commit_hash: null,
          stats_json: null,
          last_sync_at: null,
          summary: null,
        });
        recovered++;
        if (preferPrevious) {
          try { rmSync(suspectDir, { recursive: true, force: true }); }
          catch (err) { logger?.warn(`[code-graph] could not remove retired suspect ${ref.code_graph_id}: ${String(err)}`); }
        }
      } catch (err) {
        logger?.warn(`[code-graph] could not restore missing committed index ${ref.code_graph_id}: ${String(err)}`);
      }
      continue;
    }
    try { rmSync(previousDir, { recursive: true, force: true }); }
    catch (err) { logger?.warn(`[code-graph] could not remove retired index ${ref.code_graph_id}: ${String(err)}`); }
  }
  // A delete can remove its metadata row while a worker still writes the
  // directory. A crash before that worker's final cleanup leaves both the
  // canonical directory and candidate/backup siblings behind.
  cleanupOrphanDirectories(store, dataDir, logger);
  return recovered;
}

function cleanupOrphanDirectories(store: RecoveryStore, dataDir: string, logger?: { warn: (message: string) => void }): void {
  if (!existsSync(dataDir)) return;
  try {
    for (const service of readdirSync(dataDir, { withFileTypes: true })) {
      if (!service.isDirectory()) continue;
      const serviceDir = join(dataDir, service.name);
      for (const team of readdirSync(serviceDir, { withFileTypes: true })) {
        if (!team.isDirectory()) continue;
        const teamDir = join(serviceDir, team.name);
        try {
          for (const entry of readdirSync(teamDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = /^\.(cg-[0-9a-z]{8})\.candidate-[0-9a-f-]{36}$/.exec(entry.name);
            if (candidate) {
              try { rmSync(join(teamDir, entry.name), { recursive: true, force: true }); }
              catch (err) { logger?.warn(`[code-graph] could not remove orphan candidate ${entry.name}: ${String(err)}`); }
              continue;
            }
            const assetId = entry.name.endsWith(".previous")
              ? entry.name.slice(0, -".previous".length)
              : entry.name.endsWith(".suspect")
                ? entry.name.slice(0, -".suspect".length)
              : entry.name;
            if (!isCodeGraphId(assetId)) continue;
            try {
              if (store.getCodeGraph(service.name, team.name, assetId)) continue;
            } catch (err) {
              // A metadata read failure must never turn into a directory delete.
              logger?.warn(`[code-graph] could not check orphan ${entry.name}: ${String(err)}`);
              continue;
            }
            try { rmSync(join(teamDir, entry.name), { recursive: true, force: true }); }
            catch (err) { logger?.warn(`[code-graph] could not remove orphan directory ${entry.name}: ${String(err)}`); }
          }
        } catch (err) {
          logger?.warn(`[code-graph] could not scan candidates in ${teamDir}: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    logger?.warn(`[code-graph] could not scan candidates in ${dataDir}: ${String(err)}`);
  }
}
