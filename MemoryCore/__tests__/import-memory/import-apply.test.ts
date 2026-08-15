/**
 * Tests for #779 (step 3) — apply import: write files into a data directory
 * with conflict handling (skip / rename / replace).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildExportBundle } from "../../scripts/export-memory/export-memory.js";
import { applyImport } from "../../scripts/import-memory/import-memory.js";

describe("applyImport (#779 step 3)", () => {
  let srcDir: string;
  let bundle: Buffer;

  beforeEach(async () => {
    srcDir = mkdtempSync(join(tmpdir(), "tdai-apply-src-"));
    mkdirSync(join(srcDir, "conversations"), { recursive: true });
    writeFileSync(
      join(srcDir, "conversations", "2026-08-01.jsonl"),
      '{"role":"user","content":"hi"}\n',
    );
    bundle = (await buildExportBundle({ dataDir: srcDir, instanceId: "inst" })).zip;
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
  });

  function makeTargetDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tdai-apply-dst-"));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("writes files into an empty data directory", async () => {
    const dst = makeTargetDir();
    const result = await applyImport(bundle, dst, { conflict: "skip" });

    expect(result.applied).toContain(join(dst, "conversations", "2026-08-01.jsonl"));
    expect(result.skipped).toHaveLength(0);
    const written = readFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "utf8");
    expect(written).toContain("hi");
  });

  it("skips existing files with conflict=skip", async () => {
    const dst = makeTargetDir();
    mkdirSync(join(dst, "conversations"), { recursive: true });
    writeFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "ORIGINAL");

    const result = await applyImport(bundle, dst, { conflict: "skip" });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe("conversations/2026-08-01.jsonl");
    // Original untouched.
    expect(readFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "utf8")).toBe("ORIGINAL");
  });

  it("overwrites existing files with conflict=replace", async () => {
    const dst = makeTargetDir();
    mkdirSync(join(dst, "conversations"), { recursive: true });
    writeFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "ORIGINAL");

    const result = await applyImport(bundle, dst, { conflict: "replace" });
    expect(result.applied).toHaveLength(1);
    expect(readFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "utf8")).toContain("hi");
  });

  it("writes a renamed copy with conflict=rename and keeps the original", async () => {
    const dst = makeTargetDir();
    mkdirSync(join(dst, "conversations"), { recursive: true });
    writeFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "ORIGINAL");

    const result = await applyImport(bundle, dst, { conflict: "rename" });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatch(/\.import\.\d+$/);
    // Original preserved.
    expect(readFileSync(join(dst, "conversations", "2026-08-01.jsonl"), "utf8")).toBe("ORIGINAL");
    // Renamed copy has the bundle content.
    expect(readFileSync(result.applied[0], "utf8")).toContain("hi");
  });

  it("refuses to write when the bundle fails validation", async () => {
    const { default: JSZip } = await import("jszip");
    const z = await JSZip.loadAsync(bundle);
    z.file("conversations/2026-08-01.jsonl", "TAMPERED");
    const bad = await z.generateAsync({ type: "nodebuffer" });

    const dst = makeTargetDir();
    await expect(applyImport(bad, dst, { conflict: "skip" })).rejects.toThrow(/校验失败/);
    expect(existsSync(join(dst, "conversations"))).toBe(false);
  });
});
