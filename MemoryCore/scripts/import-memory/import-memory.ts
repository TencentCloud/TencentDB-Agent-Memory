#!/usr/bin/env node
/**
 * memory import — validate and dry-run an export bundle before applying it.
 *
 * Issue #779, step 2: import dry-run only (validation + conflict report). The
 * real write path (step 3) is intentionally out of scope here.
 *
 * Usage:
 *   node ./bin/import-memory.mjs --file ./memory-backup.zip --dry-run
 *
 * What it checks (without writing anything):
 *   - manifest.json exists and passes exportManifestSchema (schema_version,
 *     asset types, per-file sha256 checksums)
 *   - every file declared in the manifest exists inside the bundle
 *   - every file's content hash matches its declared checksum
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

import {
  validateManifest,
  type ExportManifest,
} from "../export-memory/manifest.js";

export interface DryRunFile {
  path: string;
  size: number;
  checksumValid: boolean;
}

export interface DryRunResult {
  manifest: ExportManifest;
  files: DryRunFile[];
  totalBytes: number;
  /** Files declared in the manifest but absent from the bundle. */
  missingFiles: string[];
  /** Files whose content hash does not match the manifest checksum. */
  checksumFailures: string[];
  /** True when every declared file exists and its checksum matches. */
  ok: boolean;
  /** Human-readable one-line summary. */
  summary: string;
}

/**
 * Validate an export bundle without writing anything to storage.
 * Throws on a malformed manifest; returns a DryRunResult otherwise.
 */
export async function dryRunImport(bundle: Buffer): Promise<DryRunResult> {
  const zip = await JSZip.loadAsync(bundle);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) {
    throw new Error("bundle 缺少 manifest.json，不是有效的导出文件");
  }

  let manifest: ExportManifest;
  try {
    manifest = validateManifest(JSON.parse(await manifestEntry.async("string")));
  } catch (err) {
    throw new Error(
      `manifest 校验失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const files: DryRunFile[] = [];
  const missingFiles: string[] = [];
  const checksumFailures: string[] = [];
  let totalBytes = 0;

  for (const asset of manifest.assets) {
    for (const f of asset.files) {
      const entry = zip.file(f.path);
      if (!entry) {
        missingFiles.push(f.path);
        continue;
      }
      const content = await entry.async("nodebuffer");
      const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      const valid = actual === f.checksum;
      if (!valid) checksumFailures.push(f.path);
      files.push({ path: f.path, size: content.length, checksumValid: valid });
      totalBytes += content.length;
    }
  }

  const ok = missingFiles.length === 0 && checksumFailures.length === 0;
  const summary = ok
    ? `dry-run OK: ${manifest.assets.length} 个资产, ${files.length} 个文件, ${totalBytes} bytes`
    : `dry-run 发现问题: 缺失 ${missingFiles.length} 个, checksum 失败 ${checksumFailures.length} 个`;

  return { manifest, files, totalBytes, missingFiles, checksumFailures, ok, summary };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string", short: "f", required: true },
      "dry-run": { type: "boolean", default: true },
    },
  });

  const bundle = await fs.readFile(values.file as string);
  const result = await dryRunImport(bundle);

  console.log(`📦 bundle: schema_version=${result.manifest.schema_version}`);
  for (const asset of result.manifest.assets) {
    console.log(`   资产: ${asset.type} (id=${asset.id}, files=${asset.files.length})`);
  }
  console.log(`   文件: ${result.files.length} 个 (${result.totalBytes} bytes)`);

  if (result.missingFiles.length > 0) {
    console.error(`❌ 缺失文件 (${result.missingFiles.length}): ${result.missingFiles.join(", ")}`);
  }
  if (result.checksumFailures.length > 0) {
    console.error(`❌ checksum 不匹配 (${result.checksumFailures.length}): ${result.checksumFailures.join(", ")}`);
  }

  if (result.ok) {
    console.log(`✅ ${result.summary} (dry-run，未写入)`);
  } else {
    console.error(`❌ ${result.summary}`);
    process.exit(1);
  }
}

// Run the CLI only when invoked directly or via the thin bin launcher
// (bin/import-memory.mjs imports this module); importers/tests get the pure
// dryRunImport without side effects.
const isCliEntry = process.argv[1] !== undefined && (
  import.meta.url === pathToFileURL(process.argv[1]).href
  || process.argv[1].endsWith("bin/import-memory.mjs")
);
if (isCliEntry) {
  main().catch((err) => {
    console.error(`❌ import dry-run 失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
