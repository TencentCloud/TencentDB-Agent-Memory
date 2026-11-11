import { existsSync, rmSync, renameSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";

export interface OkfJournal {
  wikiDir: string;
  backupDir: string;
  stageDir: string;
  targetVersion: number;
  phase: "started" | "indexing";
}

export class RecoveryError extends Error {
  constructor(msg: string) { super(msg); this.name = "RecoveryError"; }
}

/** A dangling symlink is unresolved evidence, not an absent journal. */
export function journalExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafePath(path: string, expectedParent: string, trustedRoot: string) {
  const norm = resolve(path);
  if (norm !== path) throw new RecoveryError(`Path must be absolute and normalized`);
  if (dirname(norm) !== expectedParent) throw new RecoveryError(`Path escapes expected parent`);
  if (!norm.startsWith(trustedRoot + "/")) throw new RecoveryError(`Path escapes trusted root`);

  // Check for dangling or valid symlink on path and ancestors up to trustedRoot
  let current = norm;
  while (true) {
    if (current === trustedRoot) break;
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new RecoveryError("Path or ancestor is a symbolic link");
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function writeJournal(journalPath: string, journal: OkfJournal) {
  const data = JSON.stringify(journal);
  const tmpPath = `${journalPath}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, data, "utf-8");
  renameSync(tmpPath, journalPath);
}

export function readJournal(journalPath: string, expectedWikiDir: string, trustedRoot: string): OkfJournal | null {
  assertSafePath(expectedWikiDir, dirname(expectedWikiDir), trustedRoot);
  if (!journalExists(journalPath)) return null;
  const st = lstatSync(journalPath);
  if (st.isSymbolicLink()) throw new RecoveryError("Journal file is a symbolic link");
  assertSafePath(journalPath, dirname(expectedWikiDir), trustedRoot);
  if (!st.isFile()) throw new RecoveryError("Journal must be a regular file");
  if (st.size > 1024 * 1024) throw new RecoveryError("Journal file too large");

  let data;
  try {
    data = JSON.parse(readFileSync(journalPath, "utf-8"));
  } catch {
    throw new RecoveryError("Journal file is malformed");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RecoveryError("Journal file is malformed");
  }
  const fields = ["wikiDir", "backupDir", "stageDir", "targetVersion", "phase"];
  if (Object.keys(data).some(key => !fields.includes(key))) {
    throw new RecoveryError("Journal contains unknown fields");
  }

  const { wikiDir, backupDir, stageDir, targetVersion, phase } = data;

  if (typeof wikiDir !== "string" || typeof backupDir !== "string" || typeof stageDir !== "string") {
    throw new RecoveryError("Journal file missing path fields");
  }
  if (typeof targetVersion !== "number" || !Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new RecoveryError("Journal file has invalid targetVersion");
  }
  if (phase !== "started" && phase !== "indexing") {
    throw new RecoveryError("Journal file has invalid phase");
  }

  const expectedParent = dirname(expectedWikiDir);

  if (resolve(wikiDir) !== resolve(expectedWikiDir)) {
    throw new RecoveryError("Journal wikiDir mismatch");
  }

  assertSafePath(wikiDir, expectedParent, trustedRoot);
  assertSafePath(backupDir, expectedParent, trustedRoot);
  assertSafePath(stageDir, expectedParent, trustedRoot);

  const backupName = basename(backupDir);
  const stageName = basename(stageDir);
  const wikiBase = basename(expectedWikiDir);

  const expectedBackupPrefix = `${wikiBase}.okf-backup-`;
  const expectedStagePrefix = `${wikiBase}.okf-stage-`;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!backupName.startsWith(expectedBackupPrefix) || !uuidRegex.test(backupName.slice(expectedBackupPrefix.length))) {
    throw new RecoveryError("Backup path naming violation");
  }
  if (!stageName.startsWith(expectedStagePrefix) || !uuidRegex.test(stageName.slice(expectedStagePrefix.length))) {
    throw new RecoveryError("Stage path naming violation");
  }

  return { wikiDir, backupDir, stageDir, targetVersion, phase };
}

export function resolveRecovery(journalPath: string, expectedWikiDir: string, trustedRoot: string): "roll_forward" | "operator_intervention" {
  const journal = readJournal(journalPath, expectedWikiDir, trustedRoot);
  if (!journal) return "operator_intervention";

  if (journal.phase === "indexing") {
    let wikiIsDirectory = false;
    try {
      wikiIsDirectory = lstatSync(journal.wikiDir).isDirectory();
    } catch {}

    if (wikiIsDirectory && !existsSync(journal.stageDir)) {
      return "roll_forward";
    }
  }

  return "operator_intervention";
}

export function applyRecovery(journalPath: string, expectedWikiDir: string, trustedRoot: string, currentVersion: number): { action: "rolled_forward", version: number } {
  const action = resolveRecovery(journalPath, expectedWikiDir, trustedRoot);
  if (action === "operator_intervention") {
    throw new RecoveryError("Ambiguous recovery state requires operator intervention.");
  }

  const journal = readJournal(journalPath, expectedWikiDir, trustedRoot)!;
  if (journal.targetVersion !== currentVersion && journal.targetVersion !== currentVersion + 1) {
      throw new RecoveryError("Journal targetVersion does not match current version for recovery.");
  }

  // leave backup alive, caller will index
  return { action: "rolled_forward", version: journal.targetVersion };
}

export function finishRecovery(journalPath: string, expectedWikiDir: string, trustedRoot: string, currentVersion: number) {
  // If readJournal throws (e.g. malformed JSON, symlink), we must let it throw
  // to avoid deleting the journal and destroying evidence.
  const journal = readJournal(journalPath, expectedWikiDir, trustedRoot);
  if (!journal) return;

  let wikiIsDirectory = false;
  try {
    wikiIsDirectory = lstatSync(journal.wikiDir).isDirectory();
  } catch {}

  if (journal.phase !== "indexing" || !wikiIsDirectory || existsSync(journal.stageDir)) {
    throw new RecoveryError("Cannot finalize recovery: journal is in ambiguous state or wiki directory is missing.");
  }
  if (journal.targetVersion !== currentVersion) {
    throw new RecoveryError("Cannot finalize recovery: version mismatch.");
  }

  if (existsSync(journal.backupDir)) {
    rmSync(journal.backupDir, { recursive: true, force: true });
  }
  if (existsSync(journalPath)) {
    rmSync(journalPath, { force: true });
  }
}
