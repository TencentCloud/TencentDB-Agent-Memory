/**
 * Tests for #779 (step 1) — read-only export of chat-memory to a ZIP bundle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

import { buildExportBundle } from "../../scripts/export-memory/export-memory.js";

describe("buildExportBundle (#779)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tdai-export-"));
    mkdirSync(join(dataDir, "conversations"), { recursive: true });
    mkdirSync(join(dataDir, "records"), { recursive: true });
    writeFileSync(
      join(dataDir, "conversations", "2026-08-01.jsonl"),
      '{"role":"user","content":"hi"}\n{"role":"assistant","content":"yo"}\n',
    );
    writeFileSync(join(dataDir, "records", "2026-08-01.jsonl"), '{"type":"episodic","content":"x"}\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("produces a ZIP with manifest + conversations + records", async () => {
    const { manifest, zip } = await buildExportBundle({ dataDir, instanceId: "inst-1" });

    expect(manifest.schema_version).toBe("1.0.0");
    expect(manifest.assets[0].type).toBe("chat-memory");
    expect(manifest.assets[0].id).toBe("inst-1");
    expect(manifest.assets[0].files).toHaveLength(2);

    const z = await JSZip.loadAsync(zip);
    expect(z.file("manifest.json")).toBeTruthy();
    expect(z.file("conversations/2026-08-01.jsonl")).toBeTruthy();
    expect(z.file("records/2026-08-01.jsonl")).toBeTruthy();

    const conv = manifest.assets[0].files.find((f) => f.path === "conversations/2026-08-01.jsonl")!;
    expect(conv.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(conv.size).toBeGreaterThan(0);
  });

  it("skips records when includeRecords=false", async () => {
    const { manifest } = await buildExportBundle({ dataDir, includeRecords: false });
    const paths = manifest.assets[0].files.map((f) => f.path);
    expect(paths).toEqual(["conversations/2026-08-01.jsonl"]);
  });

  it("throws when there is nothing to export", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tdai-export-empty-"));
    try {
      await expect(buildExportBundle({ dataDir: empty })).rejects.toThrow(/未找到可导出/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
