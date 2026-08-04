/**
 * Tests for #762 — tdai_read_local path-safety checks and local file reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleReadLocal, isSafeRelativePath } from "./read-local.js";

describe("isSafeRelativePath (#762)", () => {
  it("accepts plain relative paths", () => {
    expect(isSafeRelativePath("scene_blocks/career.md")).toBe(true);
    expect(isSafeRelativePath("persona.md")).toBe(true);
    expect(isSafeRelativePath("a/b/c/d.md")).toBe(true);
  });

  it("rejects empty and blank paths", () => {
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("  ")).toBe(false);
    expect(isSafeRelativePath(undefined)).toBe(false);
    expect(isSafeRelativePath(null)).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isSafeRelativePath("../secret.md")).toBe(false);
    expect(isSafeRelativePath("scene_blocks/../../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("a/..")).toBe(false);
  });

  it("rejects absolute paths (POSIX and Windows)", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\system32")).toBe(false);
    expect(isSafeRelativePath("C:/foo/bar.md")).toBe(false);
    expect(isSafeRelativePath("\\\\server\\share\\x.md")).toBe(false);
  });
});

describe("handleReadLocal (#762)", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "tdai-local-"));
    mkdirSync(join(localDir, "scene_blocks"), { recursive: true });
    writeFileSync(join(localDir, "persona.md"), "# Persona\nLikes coffee.");
    writeFileSync(join(localDir, "scene_blocks", "work.md"), "## Work scene");
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  it("reads a file by relative path", async () => {
    const result = await handleReadLocal(localDir, { path: "persona.md" });
    expect(result.content[0].text).toContain("Likes coffee");
  });

  it("reads a nested scene block", async () => {
    const result = await handleReadLocal(localDir, { path: "scene_blocks/work.md" });
    expect(result.content[0].text).toContain("Work scene");
  });

  it("rejects traversal and returns an error message", async () => {
    const result = await handleReadLocal(localDir, { path: "../secret.md" });
    expect(result.content[0].text).toMatch(/Invalid path/);
  });

  it("rejects absolute paths", async () => {
    const result = await handleReadLocal(localDir, { path: "/etc/hosts" });
    expect(result.content[0].text).toMatch(/Invalid path/);
  });

  it("returns a friendly error for a missing file", async () => {
    const result = await handleReadLocal(localDir, { path: "nope.md" });
    expect(result.content[0].text).toMatch(/Failed to read file/);
  });
});
