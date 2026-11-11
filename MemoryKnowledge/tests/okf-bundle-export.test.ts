import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { exportBundle, BundleExportError } from "../src/engines/wiki/okf-bundle-export.js";

const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(join(tmpdir(), "okf-export-")); roots.push(root); return root; };
const limit = 10 * 1024 * 1024;
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("bounded Linux OKF exporter", () => {
  it("preserves nested UTF-8 and binary bytes, orders paths and skips hidden state", () => {
    const root = temp(); fs.mkdirSync(join(root, "nested")); fs.mkdirSync(join(root, ".state"));
    const values = { "nested/中文.md": Buffer.from("---\ntype: Custom\n---\n  Body\r\n"), "a.bin": Buffer.from([0, 255, 1]) };
    for (const [path, data] of Object.entries(values)) fs.writeFileSync(join(root, path), data);
    fs.writeFileSync(join(root, ".state/key"), "synthetic-private-marker");
    const result = exportBundle(root);
    expect(result.map(f => f.path)).toEqual(["a.bin", "nested/中文.md"]);
    for (const file of result) expect(Buffer.from(file.content, "base64")).toEqual(values[file.path as keyof typeof values]);
  });
  it("supports an empty directory and empty regular files", () => {
    const root = temp(); expect(exportBundle(root)).toEqual([]);
    fs.writeFileSync(join(root, "empty.bin"), "");
    expect(exportBundle(root)).toEqual([{ path: "empty.bin", content: "", encoding: "base64" }]);
  });
  it("accepts exactly 10 MiB without modifying the file", () => {
    const root = temp(); const file = join(root, "exact.bin"); fs.writeFileSync(file, Buffer.alloc(limit, 7));
    expect(Buffer.compare(Buffer.from(exportBundle(root)[0].content, "base64"), fs.readFileSync(file))).toBe(0);
    expect(fs.statSync(file).size).toBe(limit);
  });
  it("rejects a sparse oversized file before reading any content and closes the descriptor", () => {
    const root = temp(); const file = join(root, "large.bin"); fs.writeFileSync(file, ""); fs.truncateSync(file, 64 * 1024 * 1024);
    const read = vi.spyOn(fs, "readSync"); const close = vi.spyOn(fs, "closeSync");
    expect(() => exportBundle(root)).toThrow("10 MiB");
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it("checks the remaining aggregate budget before reading the next file", () => {
    const root = temp(); fs.writeFileSync(join(root, "a.bin"), Buffer.alloc(limit)); fs.writeFileSync(join(root, "b.bin"), "x");
    const open = vi.spyOn(fs, "openSync");
    const read = vi.spyOn(fs, "readSync");
    expect(() => exportBundle(root)).toThrow("10 MiB");
    expect(open).toHaveBeenCalledTimes(2);
    expect(read.mock.invocationCallOrder.every(order => order < open.mock.invocationCallOrder[1])).toBe(true);
  });
  it("bounds reads when the actual file grows after fstat", () => {
    const root = temp(); const file = join(root, "growth.bin"); fs.writeFileSync(file, "a");
    const original = fs.readSync; let grown = false; let bytesRead = 0;
    vi.spyOn(fs, "readSync").mockImplementation(((...args: any[]) => {
      const count = (original as any)(...args); bytesRead += count;
      if (!grown) { grown = true; fs.appendFileSync(file, Buffer.alloc(limit + 100)); }
      return count;
    }) as typeof fs.readSync);
    expect(() => exportBundle(root)).toThrow("10 MiB");
    expect(bytesRead).toBe(limit + 1);
  });
  it("accepts 1000 files and refuses to open the 1001st", () => {
    const root = temp(); for (let i = 0; i < 1000; i++) fs.writeFileSync(join(root, `${String(i).padStart(4, "0")}.bin`), "");
    expect(exportBundle(root)).toHaveLength(1000); fs.writeFileSync(join(root, "1000.bin"), "");
    const open = vi.spyOn(fs, "openSync");
    expect(() => exportBundle(root)).toThrow("1000 files"); expect(open).toHaveBeenCalledTimes(1000);
  });
  it.each(["a\\b.bin", "a:b.bin", "a\n.bin"])("rejects unsafe transport filename %j", name => {
    const root = temp(); fs.writeFileSync(join(root, name), "bytes");
    expect(() => exportBundle(root)).toThrow(BundleExportError);
  });
  it("rejects root, nested directory, visible file and dangling symlinks", () => {
    const target = temp(); fs.writeFileSync(join(target, "a.bin"), "outside"); const root = temp();
    for (const destination of [target, join(target, "a.bin"), join(target, "missing")]) {
      const link = join(root, "link"); fs.symlinkSync(destination, link);
      expect(() => exportBundle(root)).toThrow(BundleExportError); fs.unlinkSync(link);
    }
    const link = join(root, "root-link"); fs.symlinkSync(target, link);
    expect(() => exportBundle(link)).toThrow(BundleExportError);
  });
  it("rejects a real FIFO without waiting for a writer", () => {
    const root = temp(); execFileSync("mkfifo", [join(root, "pipe")]);
    expect(() => exportBundle(root)).toThrow(BundleExportError);
  });
  it("refuses a leaf replaced by a symlink between discovery and open", () => {
    const root = temp(); const file = join(root, "a.bin"); fs.writeFileSync(file, "inside"); const outside = join(temp(), "outside.bin"); fs.writeFileSync(outside, "outside");
    const original = fs.openSync; let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (!swapped) { fs.unlinkSync(file); fs.symlinkSync(outside, file); swapped = true; }
      return original(...args);
    }) as typeof fs.openSync);
    expect(() => exportBundle(root)).toThrow(BundleExportError);
  });
  it("sanitizes filesystem errors rather than returning configured absolute paths", () => {
    const root = join(temp(), "missing");
    try { exportBundle(root); throw new Error("Expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(BundleExportError); expect((error as Error).message).not.toContain(root); }
  });
  it("refuses a leaf replaced by a FIFO without blocking on its open", () => {
    const root = temp(); const file = join(root, "a.bin"); fs.writeFileSync(file, "inside");
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from 'node:fs'; import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { exportBundle, BundleExportError } from './src/engines/wiki/okf-bundle-export.ts';
      const file=${JSON.stringify(file)}, root=${JSON.stringify(root)};
      const original=fs.openSync; let swapped=false;
      fs.openSync=(...args)=>{if(!swapped){swapped=true;fs.unlinkSync(file);execFileSync('mkfifo',[file]);}return original(...args);};
      assert.throws(()=>exportBundle(root), error=>error instanceof BundleExportError && error.kind==='filesystem');
      console.log('FIFO swap refused');
    `], { encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("FIFO swap refused");
  });
});
