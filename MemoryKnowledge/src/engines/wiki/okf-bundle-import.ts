/** Native filesystem import with complete preflight and staged directory replacement. */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isLocked } from "./ingest-v2/frontmatter.js";
import { validateBundle, type BundleFile, type BundleReport } from "./okf-bundle-validation.js";
export { BundleValidationError, validateBundle, type BundleFile, type BundleReport } from "./okf-bundle-validation.js";
export class BundleConflictError extends Error { constructor(msg: string) { super(msg); this.name = "BundleConflictError"; } }
export class BundleRollbackError extends Error {
  public cause: unknown;
  public backupPath: string;
  constructor(cause: unknown, backupPath: string) {
    super("Bundle swap failed and recovery rollback also failed");
    this.name = "BundleRollbackError";
    this.cause = cause;
    this.backupPath = backupPath;
  }
}

function assertTree(dir: string): void {
  if (!existsSync(dir)) return;
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new BundleConflictError("Bundle root must be a real directory");
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new BundleConflictError(`Unsupported bundle filesystem entry: ${entry}`);
    if (st.isDirectory()) assertTree(path);
  }
}

export interface ImportBundleOptions {
  overwrite?: boolean;
  stageDir?: string;
  backupDir?: string;
  retainBackup?: boolean;
}

/** Whole-bundle preflight then staged directory swap. No implicit overwrite or LLM processing. */
export function importBundle(wikiDir: string, files: BundleFile[], options: ImportBundleOptions | boolean = false): BundleReport {
  const overwrite = typeof options === "boolean" ? options : (options.overwrite ?? false);
  const retainBackup = typeof options === "boolean" ? false : (options.retainBackup ?? false);

  const report = validateBundle(files);
  // Check the parent as well, so a pre-existing root symlink cannot escape tenant storage.
  assertTree(dirname(wikiDir));

  // existing destination alias check
  const existingNorm = new Map<string, { isDir: boolean, exact: string }>();
  const scan = (d: string, p = "") => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const pth = p ? `${p}/${name}` : name;
      const isDir = lstatSync(join(d, name)).isDirectory();
      const norm = pth.normalize("NFC").toLowerCase();
      if (existingNorm.has(norm)) throw new BundleConflictError(`Ambiguous existing tree contains aliases for ${norm}`);
      existingNorm.set(norm, { isDir, exact: pth });
      if (isDir) scan(join(d, name), pth);
    }
  };
  scan(wikiDir);

  for (const file of files) {
    const norm = file.path.normalize("NFC").toLowerCase();
    const segments = norm.split("/");
    const origSegments = file.path.split("/");
    let currentOrig = "";

    for (let i = 0; i < segments.length; i++) {
        const prefix = segments.slice(0, i + 1).join("/");
        currentOrig = currentOrig ? `${currentOrig}/${origSegments[i]}` : origSegments[i];
        const existing = existingNorm.get(prefix);
        if (existing) {
            if (existing.exact !== currentOrig) throw new BundleConflictError(`Alias collision with existing destination: ${currentOrig} vs ${existing.exact}`);
            if (i < segments.length - 1 && !existing.isDir) throw new BundleConflictError(`File/directory collision with existing destination: ${file.path}`);
        }
    }

    const existing = existingNorm.get(norm);
    if (existing) {
        if (existing.isDir) throw new BundleConflictError(`Destination exists as a directory: ${file.path}`);
        if (!overwrite) throw new BundleConflictError(`Destination exists: ${file.path}`);
        if (file.path.endsWith(".md")) {
            const exactFull = join(wikiDir, existing.exact);
            if (isLocked(readFileSync(exactFull, "utf-8"))) throw new BundleConflictError(`Locked page: ${file.path}`);
        }
    }
  }
  const stage = (typeof options !== "boolean" && options.stageDir) ? options.stageDir : `${wikiDir}.okf-stage-${randomUUID()}`;
  const backup = (typeof options !== "boolean" && options.backupDir) ? options.backupDir : `${wikiDir}.okf-backup-${randomUUID()}`;
  let backedUp = false;
  try {
    if (existsSync(wikiDir)) cpSync(wikiDir, stage, { recursive: true });
    else mkdirSync(stage, { recursive: true });
    for (const file of files) {
      const full = join(stage, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf-8"));
    }
    if (existsSync(wikiDir)) { renameSync(wikiDir, backup); backedUp = true; }
    try { renameSync(stage, wikiDir); }
    catch (error) {
      if (backedUp) {
        try { renameSync(backup, wikiDir); } catch(e) {
          throw new BundleRollbackError(error, backup);
        }
      }
      throw error;
    }
  } finally {
    try { rmSync(stage, { recursive: true, force: true }); } catch (e) { /* ignore cleanup error */ }
  }
  // A crash may leave a backup for recovery; cleanup failure does not undo a successful commit.
  if (backedUp && !retainBackup) {
    try { rmSync(backup, { recursive: true, force: true }); } catch (e) { console.error("Backup cleanup failed", e); }
  }
  return report;
}
