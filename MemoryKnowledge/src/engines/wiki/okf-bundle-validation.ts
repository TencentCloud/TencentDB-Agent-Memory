/** Pure OKF exchange-bundle preflight: no filesystem, execution or network access. */
import { basename } from "node:path/posix";
import { parseDocument } from "yaml";
export class BundleValidationError extends Error {
  constructor(message: string) { super(message); this.name = "BundleValidationError"; }
}
const OKF_VERSION = "0.2";

export interface BundleFile { path: string; content: string; encoding?: "utf-8" | "base64" }
export interface BundleReport { files: number; concepts: number; warnings: Array<{ path: string; message: string }> }
const MAX_FILES = 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const RESERVED = new Set(["index.md", "log.md"]);

function safePath(path: string): boolean {
  // Node encodes lone UTF-16 surrogates as U+FFFD, creating lossy filename aliases.
  return !!path && !/[\uD800-\uDFFF]/u.test(path) && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path) && !path.startsWith("/") && !path.includes(":") &&
    path.split("/").every((s) => !!s && s !== "." && s !== ".." && !s.startsWith("."));
}
function decode(file: BundleFile, remaining: number): Buffer {
  if (file.encoding === "base64") {
    // Bound encoded input before validation or allocating decoded bytes.
    if (file.content.length > 4 * Math.ceil(remaining / 3)) throw new BundleValidationError("Bundle exceeds 10 MiB");
    const padding = file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0;
    if (file.content.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(file.content.slice(0, file.content.length - padding))) {
      throw new BundleValidationError(`Invalid base64: ${file.path}`);
    }
    if (file.content.length / 4 * 3 - padding > remaining) throw new BundleValidationError("Bundle exceeds 10 MiB");
    return Buffer.from(file.content, "base64");
  }
  if (file.encoding !== undefined && file.encoding !== "utf-8") throw new BundleValidationError("Unsupported encoding");
  if (/[\uD800-\uDFFF]/u.test(file.content)) throw new BundleValidationError("Malformed Unicode text; use base64 for raw bytes");
  if (Buffer.byteLength(file.content, "utf-8") > remaining) throw new BundleValidationError("Bundle exceeds 10 MiB");
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
      const data = decode(file, MAX_BYTES - bytes);
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
          if (doc.errors.length || file.path !== "index.md" || !value || typeof value !== "object" || Array.isArray(value) ||
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
      // Advisory actor/freshness semantics are a separate consumer concern.
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
