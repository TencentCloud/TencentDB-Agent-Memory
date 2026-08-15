import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorageBackend } from "./local-backend.js";
import { runStorageBackendContractTests } from "./__tests__/storage-backend.contract.js";

runStorageBackendContractTests("LocalStorageBackend", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "storage-local-"));
  return {
    backend: new LocalStorageBackend({ rootDir }),
    teardown: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
});

describe("LocalStorageBackend — backend-specific behavior", () => {
  it("reports type 'local'", () => {
    const backend = new LocalStorageBackend({ rootDir: "/tmp/unused" });
    expect(backend.type).toBe("local");
  });

  it("accepts a bare string rootDir for backwards compatibility", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "storage-local-strctor-"));
    try {
      const backend = new LocalStorageBackend(rootDir);
      await backend.putObject("a.md", "x");
      expect(await backend.exists("a.md")).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("stores contentType/metadata in a sidecar .meta.json and hides it from listObjects", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "storage-local-meta-"));
    try {
      const backend = new LocalStorageBackend({ rootDir });
      await backend.putObject("scene_blocks/note.md", "hi", {
        contentType: "text/markdown",
        metadata: { author: "test" },
      });
      const obj = await backend.getObject("scene_blocks/note.md");
      expect(obj!.contentType).toBe("text/markdown");
      expect(obj!.metadata).toEqual({ author: "test" });

      const listed = await backend.listObjects("scene_blocks/", { recursive: true });
      const keys = listed.entries.map((e) => e.key);
      expect(keys).toContain("scene_blocks/note.md");
      expect(keys.some((k) => k.endsWith(".meta.json"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deleteObject also removes the .meta.json sidecar", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "storage-local-meta-del-"));
    try {
      const backend = new LocalStorageBackend({ rootDir });
      await backend.putObject("persona.md", "hi", { contentType: "text/markdown" });
      await backend.deleteObject("persona.md");
      expect(await backend.exists("persona.md")).toBe(false);
      // No direct way to check the sidecar via IStorageBackend; re-put without
      // metadata and confirm getObject doesn't resurrect stale contentType.
      await backend.putObject("persona.md", "hi again");
      const obj = await backend.getObject("persona.md");
      expect(obj!.contentType).toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects a key that escapes rootDir via a sibling-directory-name trick", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "storage-local-sibling-"));
    try {
      const backend = new LocalStorageBackend({ rootDir });
      // e.g. rootDir = "/tmp/storage-local-sibling-abc", key tries to escape
      // to a sibling dir whose name starts with the same prefix.
      await expect(
        backend.putObject(`../${rootDir.split("/").pop()}-evil/x.md`, "x"),
      ).rejects.toThrow(/traversal/i);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
