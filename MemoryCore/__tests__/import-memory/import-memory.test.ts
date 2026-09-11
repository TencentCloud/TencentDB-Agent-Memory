/**
 * Tests for #779 (step 2) — import dry-run: validate the bundle and report
 * conflicts/errors without writing anything.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

import { buildExportBundle } from "../../scripts/export-memory/export-memory.js";
import { dryRunImport } from "../../scripts/import-memory/import-memory.js";

describe("dryRunImport (#779 step 2)", () => {
  let dataDir: string;
  let bundle: Buffer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "tdai-import-"));
    mkdirSync(join(dataDir, "conversations"), { recursive: true });
    writeFileSync(
      join(dataDir, "conversations", "2026-08-01.jsonl"),
      '{"role":"user","content":"hi"}\n',
    );
    bundle = (await buildExportBundle({ dataDir, instanceId: "inst" })).zip;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts a valid bundle (dry-run ok)", async () => {
    const result = await dryRunImport(bundle);

    expect(result.ok).toBe(true);
    expect(result.missingFiles).toHaveLength(0);
    expect(result.checksumFailures).toHaveLength(0);
    expect(result.manifest.assets[0].type).toBe("chat-memory");
    expect(result.files).toHaveLength(1);
  });

  it("reports files declared in the manifest but missing from the bundle", async () => {
    const z = await JSZip.loadAsync(bundle);
    z.remove("conversations/2026-08-01.jsonl");
    const tampered = await z.generateAsync({ type: "nodebuffer" });

    const result = await dryRunImport(tampered);
    expect(result.ok).toBe(false);
    expect(result.missingFiles).toContain("conversations/2026-08-01.jsonl");
  });

  it("reports checksum mismatches after content tampering", async () => {
    const z = await JSZip.loadAsync(bundle);
    z.file("conversations/2026-08-01.jsonl", '{"role":"user","content":"TAMPERED"}\n');
    const tampered = await z.generateAsync({ type: "nodebuffer" });

    const result = await dryRunImport(tampered);
    expect(result.ok).toBe(false);
    expect(result.checksumFailures).toContain("conversations/2026-08-01.jsonl");
  });

  it("throws on a malformed manifest", async () => {
    const z = await JSZip.loadAsync(bundle);
    z.file("manifest.json", JSON.stringify({ schema_version: "9.9.9", assets: [] }));
    const bad = await z.generateAsync({ type: "nodebuffer" });

    await expect(dryRunImport(bad)).rejects.toThrow(/manifest 校验失败/);
  });

  it("throws when manifest.json is absent", async () => {
    const z = await JSZip.loadAsync(bundle);
    z.remove("manifest.json");
    const noManifest = await z.generateAsync({ type: "nodebuffer" });

    await expect(dryRunImport(noManifest)).rejects.toThrow(/缺少 manifest.json/);
  });
});
