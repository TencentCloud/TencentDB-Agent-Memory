import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStorageContext, ensureDirs, readMmd, writeMmd, patchMmd, deleteMmd, readRefMd, writeRefMd } from "../src/offload/storage.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "offload-selector-")); roots.push(root);
  const ctx = createStorageContext(root, "synthetic-agent", "synthetic-session"); await ensureDirs(ctx);
  await fs.writeFile(path.join(ctx.dataDir, "outside.mmd"), "synthetic-private-record");
  await fs.writeFile(path.join(root, "outside.md"), "synthetic-private-ref");
  return ctx;
}
describe("offload file selectors stay within their lexical namespaces", () => {
  it("rejects parent traversal on MMD reads", async () => {
    const ctx = await fixture(); await expect(readMmd(ctx, "../outside.mmd")).rejects.toThrow("Invalid offload storage filename");
  });
  it("rejects parent traversal on MMD overwrites", async () => {
    const ctx = await fixture(); await expect(writeMmd(ctx, "../outside.mmd", "overwrite")).rejects.toThrow("Invalid offload storage filename");
    expect(await fs.readFile(path.join(ctx.dataDir, "outside.mmd"), "utf8")).toBe("synthetic-private-record");
  });
  it("rejects parent traversal on MMD patching", async () => {
    const ctx = await fixture(); await expect(patchMmd(ctx, "../outside.mmd", [{ startLine: 1, endLine: 1, content: "overwrite" }])).rejects.toThrow("Invalid offload storage filename");
    expect(await fs.readFile(path.join(ctx.dataDir, "outside.mmd"), "utf8")).toBe("synthetic-private-record");
  });
  it("rejects parent traversal on MMD deletion", async () => {
    const ctx = await fixture(); await expect(deleteMmd(ctx, "../outside.mmd")).rejects.toThrow("Invalid offload storage filename");
    expect(await fs.readFile(path.join(ctx.dataDir, "outside.mmd"), "utf8")).toBe("synthetic-private-record");
  });
  it("rejects parent traversal on ref reads", async () => {
    const ctx = await fixture(); await expect(readRefMd(ctx, "../outside.md")).rejects.toThrow("Invalid offload ref path");
  });
  it("rejects reading an MMD through the ref namespace", async () => {
    const ctx = await fixture(); await fs.writeFile(path.join(ctx.mmdsDir, "private.mmd"), "synthetic-private-record");
    await expect(readRefMd(ctx, "mmds/private.mmd")).rejects.toThrow("Invalid offload ref path");
  });
  it("preserves ordinary Unicode names, patching, deletion, refs and missing-file results", async () => {
    const ctx = await fixture(); const name = "task-zażółć.mmd";
    await writeMmd(ctx, name, "one\ntwo"); expect(await readMmd(ctx, name)).toBe("one\ntwo");
    expect(await patchMmd(ctx, name, [{ startLine: 2, endLine: 2, content: "three" }])).toBe(true);
    expect(await readMmd(ctx, name)).toBe("one\nthree"); expect(await deleteMmd(ctx, name)).toBe(true);
    expect(await deleteMmd(ctx, name)).toBe(false); expect(await readMmd(ctx, name)).toBeNull();
    const ref = await writeRefMd(ctx, "2026-10-13T00:00:00.000Z", "synthetic-tool", "synthetic-result");
    expect(await readRefMd(ctx, ref)).toContain("synthetic-result"); expect(await readRefMd(ctx, "refs/missing.md")).toBeNull();
  });
});
