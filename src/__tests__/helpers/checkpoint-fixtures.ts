import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import type { IMemoryStore } from "../../core/store/types.js";
import { CheckpointManager, type Checkpoint, type CheckpointLogger } from "../../utils/checkpoint.js";

export function createTempDirFixture(prefix: string) {
  const directories: string[] = [];
  return {
    async create(canonicalDirs = false): Promise<string> {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      directories.push(dataDir);
      if (canonicalDirs) {
        await Promise.all(["conversations", "records"].map((directory) =>
          fs.mkdir(path.join(dataDir, directory), { recursive: true })));
      }
      return dataDir;
    },
    async cleanup(): Promise<void> {
      await Promise.all(directories.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true })));
    },
  };
}

export function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

export function createMemoryStoreMock(overrides: Partial<IMemoryStore> = {}): IMemoryStore {
  return { isDegraded: () => false, ...overrides } as IMemoryStore;
}

export async function seedCheckpoint(
  dataDir: string,
  values: Partial<Checkpoint>,
  logger?: CheckpointLogger,
): Promise<CheckpointManager> {
  const manager = new CheckpointManager(dataDir, logger);
  const checkpoint = await manager.read();
  Object.assign(checkpoint, values);
  await manager.write(checkpoint);
  return manager;
}

export async function writeJsonlShard(
  dataDir: string,
  directory: "conversations" | "records",
  shardName: string,
  records: readonly unknown[],
): Promise<string> {
  const dirPath = path.join(dataDir, directory);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, shardName);
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return filePath;
}
