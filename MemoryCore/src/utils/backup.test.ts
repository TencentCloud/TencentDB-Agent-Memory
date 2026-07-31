import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { StoragePaths } from "../core/storage/types.js";
import { BackupManager } from "./backup.js";

const tempDirs: string[] = [];

async function createStorage(): Promise<StorageAdapter> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-backup-"));
  tempDirs.push(dir);
  return new StorageAdapter(new LocalStorageBackend(dir));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("BackupManager StorageAdapter mode", () => {
  it("backs up persona objects and prunes the oldest entries", async () => {
    const storage = await createStorage();
    const manager = new BackupManager(StoragePaths.backupDir, storage);

    for (let version = 1; version <= 3; version++) {
      await storage.writeFile(StoragePaths.persona, `persona-v${version}`);
      await manager.backupFile(
        StoragePaths.persona,
        "persona",
        `offset${version}`,
        2,
      );
    }

    const entries = (await storage.readdir(".backup/persona/"))
      .filter((entry) => !entry.isDirectory)
      .sort((a, b) => a.key.localeCompare(b.key));

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.key)).toEqual([
      expect.stringContaining("offset2.md"),
      expect.stringContaining("offset3.md"),
    ]);
    await expect(storage.readFile(entries[0].key)).resolves.toBe("persona-v2");
    await expect(storage.readFile(entries[1].key)).resolves.toBe("persona-v3");
  });

  it("does nothing when the source object does not exist", async () => {
    const storage = await createStorage();
    const manager = new BackupManager(StoragePaths.backupDir, storage);

    await manager.backupFile(StoragePaths.persona, "persona", "offset0", 3);

    await expect(storage.readdir(".backup/persona/")).resolves.toEqual([]);
  });
});
