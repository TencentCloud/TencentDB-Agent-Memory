import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { StorageAdapter } from "../storage/adapter.js";
import type { LLMRunner } from "../types.js";
import { PersonaGenerator } from "./persona-generator.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persona-generator-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("PersonaGenerator atomic publication", () => {
  it("keeps the live storage persona unchanged when the runner writes a draft and then fails", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    const previousPersona = "# Stable persona\n\nKeep this published version.";
    await storage.writeFile("persona.md", previousPersona);
    await storage.writeFile("scene_blocks/work.md", "# Work\n\nNew operating preference.");
    await storage.writeFile(".metadata/scene_index.json", JSON.stringify([{
      filename: "work.md",
      summary: "Work preference",
      heat: 1,
      created: "2026-09-09T10:00:00.000Z",
      updated: "2026-09-09T10:00:00.000Z",
    }]));

    let draftDir = "";
    const runner: LLMRunner = {
      async run(params) {
        draftDir = params.workspaceDir ?? "";
        expect(draftDir).not.toBe(dataDir);
        expect(params.storage).toBeUndefined();
        await fs.writeFile(path.join(draftDir, "persona.md"), "# Partial, must never be published", "utf-8");
        throw new Error("upstream rate limit after tool call");
      },
    };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("test failure")).rejects.toThrow("upstream rate limit after tool call");
    await expect(storage.readFile("persona.md")).resolves.toBe(previousPersona);
    await expect(fs.stat(draftDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a live filesystem persona when a first-generation draft fails", async () => {
    const dataDir = await makeTempDir();
    const runner: LLMRunner = {
      async run(params) {
        await fs.writeFile(path.join(params.workspaceDir!, "persona.md"), "# Partial", "utf-8");
        throw new Error("model failed");
      },
    };

    const generator = new PersonaGenerator({ dataDir, config: {}, llmRunner: runner });
    await expect(generator.generateLocalPersona("test failure")).rejects.toThrow("model failed");
    await expect(fs.stat(path.join(dataDir, "persona.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a validated draft only after the runner completes", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    const runner: LLMRunner = {
      async run(params) {
        await fs.writeFile(
          path.join(params.workspaceDir!, "persona.md"),
          "# Complete persona\n\nNever emit </user-persona> literally.",
          "utf-8",
        );
        return "done";
      },
    };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("test success")).resolves.toBe(true);
    await expect(storage.readFile("persona.md")).resolves.toBe(
      "# Complete persona\n\nNever emit &lt;/user-persona&gt; literally.",
    );
  });

  it("returns false only for a successful no-change decision", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    await storage.writeFile("persona.md", "# Stable persona");
    await storage.writeFile(".metadata/scene_index.json", "[]");
    const runner: LLMRunner = {
      async run() {
        throw new Error("runner must not be called");
      },
    };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("no changes")).resolves.toBe(false);
    await expect(storage.readFile("persona.md")).resolves.toBe("# Stable persona");
  });

  it("rejects a live persona read failure instead of treating it as a cold start", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (key) => {
      if (key === "persona.md") throw new Error("storage unavailable");
      return originalRead(key);
    });
    const runner: LLMRunner = { async run() { throw new Error("runner must not be called"); } };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("read failure")).rejects.toThrow("Could not read existing persona.md");
  });

  it("rejects a scene-index read failure instead of treating it as no changes", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    await storage.writeFile("persona.md", "# Stable persona");
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (key) => {
      if (key === ".metadata/scene_index.json") throw new Error("storage unavailable");
      return originalRead(key);
    });
    const runner: LLMRunner = { async run() { throw new Error("runner must not be called"); } };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("index failure")).rejects.toThrow("Could not read scene index");
    await expect(storage.readFile("persona.md")).resolves.toBe("# Stable persona");
  });

  it("rejects a missing changed scene instead of advancing past incomplete evidence", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    await storage.writeFile("persona.md", "# Stable persona");
    await storage.writeFile(".metadata/scene_index.json", JSON.stringify([{
      filename: "missing.md",
      summary: "Missing evidence",
      heat: 1,
      created: "2026-09-09T10:00:00.000Z",
      updated: "2026-09-09T10:00:00.000Z",
    }]));
    const runner: LLMRunner = { async run() { throw new Error("runner must not be called"); } };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("missing scene"))
      .rejects.toThrow("Could not read changed scene block: missing.md");
    await expect(storage.readFile("persona.md")).resolves.toBe("# Stable persona");
  });

  it("rejects a scene-index filename that escapes the scene directory", async () => {
    const dataDir = await makeTempDir();
    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    await storage.writeFile("persona.md", "# Stable persona");
    await storage.writeFile(".metadata/scene_index.json", JSON.stringify([{
      filename: "../../persona.md",
      summary: "Unsafe evidence",
      heat: 1,
      created: "2026-09-09T10:00:00.000Z",
      updated: "2026-09-09T10:00:00.000Z",
    }]));
    const runner: LLMRunner = { async run() { throw new Error("runner must not be called"); } };

    const generator = new PersonaGenerator({ dataDir, config: {}, storage, llmRunner: runner });
    await expect(generator.generateLocalPersona("unsafe index")).rejects.toThrow("Could not read scene index");
    await expect(storage.readFile("persona.md")).resolves.toBe("# Stable persona");
  });
});
