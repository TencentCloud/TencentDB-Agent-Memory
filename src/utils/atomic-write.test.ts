import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";

describe("atomicWriteFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes content to a new file", async () => {
    const p = path.join(dir, "persona.md");
    await atomicWriteFile(p, "hello");
    expect(await fs.readFile(p, "utf-8")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const p = path.join(dir, "persona.md");
    await fs.writeFile(p, "old", "utf-8");
    await atomicWriteFile(p, "new");
    expect(await fs.readFile(p, "utf-8")).toBe("new");
  });

  it("leaves no temp files behind on success", async () => {
    const p = path.join(dir, "scene_index.json");
    await atomicWriteFile(p, JSON.stringify({ a: 1 }));
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["scene_index.json"]);
  });

  it("does not corrupt the existing file when the write throws", async () => {
    const p = path.join(dir, "persona.md");
    await atomicWriteFile(p, "original");
    // Target a non-existent nested dir to force a write failure.
    const bad = path.join(dir, "no-such-subdir", "persona.md");
    await expect(atomicWriteFile(bad, "doomed")).rejects.toBeTruthy();
    // Original untouched.
    expect(await fs.readFile(p, "utf-8")).toBe("original");
  });

  it("survives concurrent writes to different files without temp collisions", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        atomicWriteFile(path.join(dir, `f${i}.md`), `content-${i}`),
      ),
    );
    const entries = (await fs.readdir(dir)).sort();
    expect(entries).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(await fs.readFile(path.join(dir, `f${i}.md`), "utf-8")).toBe(`content-${i}`);
    }
  });
});
