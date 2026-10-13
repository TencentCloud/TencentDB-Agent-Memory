/** Native, no-LLM bundle transport. Bytes and paths are preserved; indexes stay derived. */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { isLocked } from "./ingest-v2/frontmatter.js";
import { readOkfMetadata, OKF_VERSION } from "./okf.js";

export class BundleValidationError extends Error { constructor(msg: string) { super(msg); this.name = "BundleValidationError"; } }
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

export interface BundleFile { path: string; content: string; encoding?: "utf-8" | "base64" }
export interface BundleReport { files: number; concepts: number; warnings: Array<{ path: string; message: string }> }
const MAX_FILES = 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const RESERVED = new Set(["index.md", "log.md"]);

function safePath(path: string): boolean {
  return !!path && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && !path.includes(":") &&
    path.split("/").every((s) => !!s && s !== "." && s !== ".." && !s.startsWith("."));
}
function decode(file: BundleFile): Buffer {
  if (file.encoding === "base64") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new BundleValidationError(`Invalid base64: ${file.path}`);
    return Buffer.from(file.content, "base64");
  }
  if (file.encoding !== undefined && file.encoding !== "utf-8") throw new BundleValidationError("Unsupported encoding");
  return Buffer.from(file.content, "utf-8");
}

export function validateBundle(files: BundleFile[]): BundleReport {
  try {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new BundleValidationError(`Bundle requires 1..${MAX_FILES} files`);
    const paths = new Set<string>();
    const normPaths = new Set<string>();
    const report: BundleReport = { files: files.length, concepts: 0, warnings: [] };
    let bytes = 0;
    for (const file of files) {
      if (!file || typeof file.path !== "string" || typeof file.content !== "string" || !safePath(file.path)) throw new BundleValidationError("Invalid bundle file/path");
      if (paths.has(file.path)) throw new BundleValidationError(`Duplicate bundle path: ${file.path}`);
      const norm = file.path.normalize("NFC").toLowerCase();
      if (normPaths.has(norm)) throw new BundleValidationError(`Duplicate bundle path alias: ${file.path}`);
      normPaths.add(norm);
      paths.add(file.path);
      const data = decode(file);
      bytes += data.length;
      if (bytes > MAX_BYTES) throw new BundleValidationError("Bundle exceeds 10 MiB");
      if (!file.path.endsWith(".md")) continue;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const name = basename(file.path);
      if (RESERVED.has(name)) {
        if (name === "index.md" && fm) {
          const doc = parseDocument(fm[1]);
          const value = doc.toJS();
          if (doc.errors.length || file.path !== "index.md" || !value || typeof value !== "object" ||
            Object.keys(value).some((k) => k !== "okf_version")) throw new BundleValidationError(`Invalid index frontmatter: ${file.path}`);
          if (value.okf_version !== OKF_VERSION) report.warnings.push({ path: file.path, message: "Unknown OKF version; best-effort consumption" });
        }
        if (name === "log.md") for (const heading of text.matchAll(/^## (.+)$/gm)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(heading[1])) report.warnings.push({ path: file.path, message: "Log date heading is not YYYY-MM-DD" });
        }
        continue;
      }
      if (!fm) throw new BundleValidationError(`Concept requires YAML frontmatter: ${file.path}`);
      const doc = parseDocument(fm[1]);
      const value = doc.toJS();
      if (doc.errors.length || !value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string" || !value.type.trim()) {
        throw new BundleValidationError(`Concept requires parseable YAML and nonempty type: ${file.path}`);
      }
      report.concepts++;
      for (const message of readOkfMetadata(text).warnings) report.warnings.push({ path: file.path, message });
    }
    const prefixMap = new Map<string, string>();
    for (const path of paths) {
      const segments = path.split("/");
      let currentOrig = "";
      let currentNorm = "";
      for (let i = 0; i < segments.length; i++) {
          currentOrig = currentOrig ? `${currentOrig}/${segments[i]}` : segments[i];
          currentNorm = currentNorm ? `${currentNorm}/${segments[i].normalize("NFC").toLowerCase()}` : segments[i].normalize("NFC").toLowerCase();

          if (i < segments.length - 1 && normPaths.has(currentNorm)) throw new BundleValidationError(`File/directory collision: ${path}`);

          const existingOrig = prefixMap.get(currentNorm);
          if (existingOrig !== undefined && existingOrig !== currentOrig) {
              throw new BundleValidationError(`Directory alias collision: ${currentOrig} vs ${existingOrig}`);
          }
          prefixMap.set(currentNorm, currentOrig);
      }
    }
    return report;
  } catch (e) {
    if (e instanceof BundleValidationError) throw e;
    throw new BundleValidationError((e as Error).message);
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

export function exportBundle(wikiDir: string): BundleFile[] {
  assertTree(wikiDir);
  const files: BundleFile[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue; // No application state/secrets in exchange bundles.
      const path = prefix + name;
      const full = join(dir, name);
      if (lstatSync(full).isDirectory()) walk(full, path + "/");
      else {
        const data = readFileSync(full);
        bytes += data.length;
        if (bytes > MAX_BYTES || files.length >= MAX_FILES) throw new BundleValidationError("Bundle exceeds transport limits");
        files.push({ path, content: data.toString("base64"), encoding: "base64" });
      }
    }
  };
  walk(wikiDir);
  return files;
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
      writeFileSync(full, decode(file));
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
