import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reclaimOffloadData } from "../src/offload/reclaimer.js";
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reclaim-safety-")); roots.push(root);
  const data = path.join(root, "data"), agent = path.join(data, "agent"), outside = path.join(root, "outside");
  await fs.mkdir(agent, { recursive: true }); await fs.mkdir(outside);
  return { root, data, agent, outside };
}
async function oldFile(file: string, body = "synthetic-data", offset = 0) {
  await fs.writeFile(file, body); const time = new Date(Date.now() - 30 * 86_400_000 + offset); await fs.utimes(file, time, time);
}
async function mmds(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < 16; i++) await oldFile(path.join(dir, `${i}.mmd`), "synthetic-mmd", i * 1000);
}
const reclaim = (data: string) => reclaimOffloadData(data, { retentionDays: 3, logMaxSizeMb: 1 }, logger);
describe("offload reclaim avoids destructive guesses and symlink targets", () => {
  it.each(["missing", "corrupt", "array"])("preserves MMDs when active state is %s", async kind => {
    const f = await fixture(); const dir = path.join(f.agent, "mmds"); await mmds(dir);
    if (kind !== "missing") await fs.writeFile(path.join(f.agent, "state.json"), kind === "corrupt" ? "{" : "[]");
    expect((await reclaim(f.data)).deletedMmds).toBe(0); expect(await fs.readdir(dir)).toHaveLength(16);
  });
  it("retains the active MMD while pruning a known expired inactive MMD", async () => {
    const f = await fixture(); const dir = path.join(f.agent, "mmds"); await mmds(dir);
    await fs.writeFile(path.join(f.agent, "state.json"), JSON.stringify({ activeMmdFile: "0.mmd" }));
    expect((await reclaim(f.data)).deletedMmds).toBe(1); expect(await fs.readFile(path.join(dir, "0.mmd"), "utf8")).toBe("synthetic-mmd");
    expect(await fs.readdir(dir)).toHaveLength(15);
  });
  it.each(["corrupt", "unreadable", "primitive"])("preserves refs when surviving JSONL evidence is %s", async kind => {
    const f = await fixture(); const dir = path.join(f.agent, "refs"); await fs.mkdir(dir);
    await oldFile(path.join(dir, "keep.md")); const index = path.join(f.agent, "offload-live.jsonl");
    if (kind === "unreadable") await fs.mkdir(index);
    else await fs.writeFile(index, kind === "corrupt" ? "{\n" : "42\n");
    expect((await reclaim(f.data)).deletedRefs).toBe(0); expect(await fs.readFile(path.join(dir, "keep.md"), "utf8")).toBe("synthetic-data");
  });
  it("keeps a known referenced ref and removes a proven expired orphan", async () => {
    const f = await fixture(); const dir = path.join(f.agent, "refs"); await fs.mkdir(dir);
    await oldFile(path.join(dir, "keep.md")); await oldFile(path.join(dir, "orphan.md"));
    await fs.writeFile(path.join(f.agent, "offload-live.jsonl"), JSON.stringify({ result_ref: "refs/keep.md" }) + "\n");
    expect((await reclaim(f.data)).deletedRefs).toBe(1); expect(await fs.readdir(dir)).toEqual(["keep.md"]);
  });
  it("does not delete files through a refs directory symlink", async () => {
    const f = await fixture(); await oldFile(path.join(f.outside, "keep.md")); await fs.symlink(f.outside, path.join(f.agent, "refs"));
    expect((await reclaim(f.data)).deletedRefs).toBe(0); expect(await fs.readFile(path.join(f.outside, "keep.md"), "utf8")).toBe("synthetic-data");
  });
  it("does not delete files through an MMD directory symlink", async () => {
    const f = await fixture(); await mmds(f.outside); await fs.symlink(f.outside, path.join(f.agent, "mmds"));
    await fs.writeFile(path.join(f.agent, "state.json"), JSON.stringify({ activeMmdFile: null }));
    expect((await reclaim(f.data)).deletedMmds).toBe(0); expect(await fs.readdir(f.outside)).toHaveLength(16);
  });
  it("does not truncate a log symlink's external target", async () => {
    const f = await fixture(); const file = path.join(f.outside, "keep.log"); const contents = "a".repeat(2 * 1024 * 1024);
    await fs.writeFile(file, contents); await fs.symlink(file, path.join(f.data, "debug.log"));
    expect((await reclaim(f.data)).truncatedLogs).toBe(0); expect((await fs.stat(file)).size).toBe(contents.length);
  });
  it("does not use symlinked state as authority for MMD deletion", async () => {
    const f = await fixture(); const dir = path.join(f.agent, "mmds"); await mmds(dir);
    const state = path.join(f.outside, "state.json"); await fs.writeFile(state, JSON.stringify({ activeMmdFile: null }));
    await fs.symlink(state, path.join(f.agent, "state.json"));
    expect((await reclaim(f.data)).deletedMmds).toBe(0); expect(await fs.readdir(dir)).toHaveLength(16);
  });
});
