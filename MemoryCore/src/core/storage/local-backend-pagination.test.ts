import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalStorageBackend } from "./local-backend.js";
import { runStorageBackendContract } from "./__contract__/storage-backend.contract.js";

runStorageBackendContract("local", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-storage-contract-"));
  return {
    backend: new LocalStorageBackend(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

it("pages every local object once beyond the former 10,000-object collection limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-storage-pagination-"));
  const backend = new LocalStorageBackend(root);
  const keys = Array.from({ length: 10_001 }, (_, i) => `records/entry-${String(i).padStart(5, "0")}.jsonl`);
  try {
    // Bound open files while exercising the real storage write/list APIs.
    for (let start = 0; start < keys.length; start += 64) {
      await Promise.all(keys.slice(start, start + 64).map((key) => backend.putObject(key, "")));
    }
    const first = await backend.listObjects("records/", { recursive: true, maxKeys: 7_000 });
    const second = await backend.listObjects("records/", { recursive: true, maxKeys: 7_000, marker: first.nextMarker });
    expect(first.total).toBe(7_000);
    expect(first.nextMarker).toBe(keys[6_999]);
    expect(second.total).toBe(3_001);
    expect(second.nextMarker).toBeUndefined();
    const seen = [...first.entries, ...second.entries].map((entry) => entry.key);
    expect(seen).toEqual(keys);
    expect(new Set(seen).size).toBe(keys.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
