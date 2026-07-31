import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { countL1JsonlRecords } from "./l1-reader.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";

describe("countL1JsonlRecords", () => {
  const tempDirs: string[] = [];

  async function createDataDir(): Promise<string> {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "l1-jsonl-count-test-"));
    tempDirs.push(dataDir);
    return dataDir;
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("counts valid records across JSONL shards", async () => {
    const dataDir = await createDataDir();
    const recordsDir = path.join(dataDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-30.jsonl"),
      '{"id":"1"}\n{"id":"2"}\n\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(recordsDir, "2026-07-31.jsonl"),
      '{"id":"3"}\r\n{"id":"4"}\r\n',
      "utf-8",
    );
    await fs.writeFile(path.join(recordsDir, "ignore.txt"), '{"id":"5"}\n', "utf-8");

    await expect(countL1JsonlRecords(dataDir)).resolves.toBe(4);
  });

  it("ignores blank and malformed lines", async () => {
    const dataDir = await createDataDir();
    const recordsDir = path.join(dataDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-31.jsonl"),
      '{"id":"1"}\nnot-json\n  \n{"id":"2"}\n',
      "utf-8",
    );
    const warn = vi.fn();

    await expect(countL1JsonlRecords(dataDir, {
      info: vi.fn(),
      warn,
      error: vi.fn(),
    })).resolves.toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reflects records removed by manual JSONL pruning", async () => {
    const dataDir = await createDataDir();
    const recordsDir = path.join(dataDir, "records");
    const shardPath = path.join(recordsDir, "2026-07-31.jsonl");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      shardPath,
      '{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n',
      "utf-8",
    );

    await expect(countL1JsonlRecords(dataDir)).resolves.toBe(3);

    await fs.writeFile(shardPath, '{"id":"1"}\n', "utf-8");

    await expect(countL1JsonlRecords(dataDir)).resolves.toBe(1);
  });

  it("returns zero when the records directory does not exist", async () => {
    const dataDir = await createDataDir();

    await expect(countL1JsonlRecords(dataDir)).resolves.toBe(0);
  });

  it("counts records through the configured storage adapter", async () => {
    const dataDir = await createDataDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));

    await storage.writeFile(
      "records/2026-07-31.jsonl",
      '{"id":"1"}\n{"id":"2"}\n',
    );

    // Deliberately pass an unrelated baseDir: when storage is configured it
    // must be the source of truth for both local-adapter and COS deployments.
    await expect(
      countL1JsonlRecords(path.join(dataDir, "unused"), undefined, storage),
    ).resolves.toBe(2);
  });
});
