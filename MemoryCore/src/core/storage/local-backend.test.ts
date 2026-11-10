import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageBackend } from "./local-backend.js";
import { runStorageBackendContract } from "./__contract__/storage-backend.contract.js";

const roots: string[] = [];

async function createBackend(): Promise<{ backend: LocalStorageBackend; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "memory-local-storage-"));
  roots.push(root);
  return { backend: new LocalStorageBackend(root), root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

runStorageBackendContract("local", async () => {
  const { backend } = await createBackend();
  return { backend };
});

describe("LocalStorageBackend instance destruction", () => {
  it("deletes every object for an empty prefix and counts objects rather than sidecars", async () => {
    const { backend, root } = await createBackend();
    await backend.putObject("persona.md", "persona", { metadata: { version: "1" } });
    await backend.putObject("scene_blocks/work.md", "work");
    await backend.putObject("scene_blocks/nested/home.md", "home");

    expect(await backend.deleteByPrefix("")).toBe(3);
    expect(await backend.listObjects("", { recursive: true })).toEqual({ entries: [], total: 0 });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await backend.deleteByPrefix("")).toBe(0);
  });

  it("keeps other directories when deleting a nonempty directory prefix", async () => {
    const { backend } = await createBackend();
    await backend.putObject("persona.md", "persona");
    await backend.putObject("scene_blocks/work.md", "work");
    expect(await backend.deleteByPrefix("scene_blocks/")).toBe(1);
    expect((await backend.getObject("persona.md"))?.content.toString()).toBe("persona");
  });
});
