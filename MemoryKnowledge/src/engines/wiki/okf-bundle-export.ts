/** Byte-preserving filesystem export with bounded file reads; no network or execution. */
import fs from "node:fs";
import { join } from "node:path";

export interface ExportedBundleFile { path: string; content: string; encoding: "base64" }
export type BundleExportFailure = "budget" | "filesystem" | "path";
export class BundleExportError extends Error {
  constructor(message: string, public readonly kind: BundleExportFailure) {
    super(message); this.name = "BundleExportError";
  }
}
const MAX_FILES = 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function readBoundedFile(file: string, remaining: number): Buffer {
  if (typeof fs.constants.O_NOFOLLOW !== "number" || typeof fs.constants.O_NONBLOCK !== "number") {
    throw new BundleExportError("Checked file opens are unavailable on this platform", "filesystem");
  }
  let fd: number | undefined;
  try {
    // Leaf links are refused; nonblocking open also avoids waiting on a replaced FIFO.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new BundleExportError("Bundle entries must be regular files", "filesystem");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > remaining) {
      throw new BundleExportError("Bundle exceeds 10 MiB", "budget");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      // A sentinel byte detects growth after fstat without reading the entire new file.
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining - bytes + 1));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, bytes);
      bytes += count;
      if (bytes > remaining) throw new BundleExportError("Bundle exceeds 10 MiB", "budget");
      chunks.push(chunk.subarray(0, count));
    }
  } catch (error) {
    if (error instanceof BundleExportError) throw error;
    throw new BundleExportError("Unable to read bundle file", "filesystem");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Export existing visible regular files. Format preflight and authorization are separate. */
export function exportBundle(wikiDir: string): ExportedBundleFile[] {
  const files: ExportedBundleFile[] = [];
  let bytes = 0;
  const pending = [{ full: wikiDir, relative: "" }];
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      const stat = fs.lstatSync(directory.full);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new BundleExportError("Bundle root and directories must be real directories", "filesystem");
      }
      for (const name of fs.readdirSync(directory.full).sort()) {
        if (name.startsWith(".")) continue;
        if (/[\\:\u0000-\u001f\u007f]/.test(name)) throw new BundleExportError("Unsafe bundle path", "path");
        const full = join(directory.full, name);
        const relative = directory.relative ? `${directory.relative}/${name}` : name;
        const entry = fs.lstatSync(full);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          throw new BundleExportError("Unsupported bundle filesystem entry", "filesystem");
        }
        if (entry.isDirectory()) pending.push({ full, relative });
        else {
          if (files.length >= MAX_FILES) throw new BundleExportError("Bundle exceeds 1000 files", "budget");
          const data = readBoundedFile(full, MAX_BYTES - bytes);
          bytes += data.length;
          files.push({ path: relative, content: data.toString("base64"), encoding: "base64" });
        }
      }
    }
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  } catch (error) {
    if (error instanceof BundleExportError) throw error;
    throw new BundleExportError("Unable to export bundle tree", "filesystem");
  }
}
