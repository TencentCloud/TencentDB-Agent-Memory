import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneExtractor } from "../src/core/scene/scene-extractor.js";
import { BackupManager } from "../src/utils/backup.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scene-recovery-")); roots.push(root);
  const scenes = path.join(root, "scene_blocks"); await fs.mkdir(scenes);
  return { root, scenes };
}
it("does not resurrect an older snapshot after a failed extraction starting with empty scenes", async () => {
  const { root, scenes } = await fixture();
  await fs.writeFile(path.join(scenes, "old.md"), "synthetic obsolete scene");
  await new BackupManager(path.join(root, ".backup")).backupDirectory(scenes, "scene_blocks", "old", 10);
  await fs.unlink(path.join(scenes, "old.md"));
  const extractor = new SceneExtractor({ dataDir: root, config: {}, llmRunner: { run: async () => { throw new Error("synthetic failure"); } } });
  expect(await extractor.extract([{ content: "synthetic memory", created_at: "2026-01-01" }])).toMatchObject({ success: false, memoriesProcessed: 0 });
  expect(await fs.readdir(scenes)).toEqual([]);
});
it("preserves a newer write when the extraction runner fails after a backup", async () => {
  const { root, scenes } = await fixture(); const file = path.join(scenes, "current.md");
  await fs.writeFile(file, "synthetic original");
  const extractor = new SceneExtractor({ dataDir: root, config: {}, llmRunner: { run: async () => {
    await fs.writeFile(file, "synthetic newer write"); throw new Error("synthetic failure");
  } } });
  expect(await extractor.extract([{ content: "synthetic memory", created_at: "2026-01-01" }])).toMatchObject({ success: false, error: "synthetic failure" });
  expect(await fs.readFile(file, "utf8")).toBe("synthetic newer write");
  expect(await new BackupManager(path.join(root, ".backup")).findLatestBackup("scene_blocks")).toBeTruthy();
});
