#!/usr/bin/env node
/**
 * memory import — validate and apply an export bundle.
 *
 * Issue #779, step 2 (dry-run) + step 3 (apply with conflict handling).
 *
 * Usage:
 *   # Validate only — nothing is written
 *   node ./bin/import-memory.mjs --file ./memory-backup.zip --dry-run
 *
 *   # Apply into a data directory (writes conversations/ + records/)
 *   node ./bin/import-memory.mjs --file ./memory-backup.zip --data-dir <dir> --apply \
 *       --on-conflict skip|rename|replace
 *
 * Validation (always runs first):
 *   - manifest.json exists and passes exportManifestSchema (schema_version,
 *     asset types, per-file sha256 checksums)
 *   - every file declared in the manifest exists inside the bundle
 *   - every file's content hash matches its declared checksum
 *
 * Conflict policy (--apply only, key = same target path already on disk):
 *   - skip    (default): leave the existing file untouched
 *   - rename : write the bundle copy as "<path>.import.<timestamp>"
 *   - replace: overwrite the existing file
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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

export type ConflictPolicy = "skip" | "rename" | "replace";

export interface ApplyResult {
  /** Files written (target paths on disk). */
  applied: string[];
  /** Files not written, with the reason. */
  skipped: { path: string; reason: string }[];
  totalFiles: number;
}

/**
 * Write a file, creating parent directories as needed.
 */
async function writeFileDir(filePath: string, content: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

/**
 * Apply an export bundle into a data directory, honouring a conflict policy.
 *
 * Runs the full dry-run validation first and refuses to write anything when
 * the bundle has missing files or checksum failures.
 */
export async function applyImport(
  bundle: Buffer,
  dataDir: string,
  opts: { conflict: ConflictPolicy },
): Promise<ApplyResult> {
  const check = await dryRunImport(bundle);
  if (!check.ok) {
    throw new Error(`bundle 校验失败，未写入任何文件: ${check.summary}`);
  }

  const root = path.resolve(dataDir);
  const zip = await JSZip.loadAsync(bundle);
  const applied: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const f of check.files) {
    const target = path.resolve(root, f.path);
    // Safety: the resolved target must stay inside the data directory.
    if (target !== root && !target.startsWith(root + path.sep)) {
      skipped.push({ path: f.path, reason: "path escapes data directory" });
      continue;
    }

    const exists = await fs.access(target).then(() => true).catch(() => false);
    if (exists) {
      if (opts.conflict === "skip") {
        skipped.push({ path: f.path, reason: `conflict=skip (exists: ${target})` });
        continue;
      }
      if (opts.conflict === "rename") {
        const alt = `${target}.import.${Date.now()}`;
        const entry = zip.file(f.path);
        if (entry) await writeFileDir(alt, await entry.async("nodebuffer"));
        applied.push(alt);
        continue;
      }
      // conflict=replace → overwrite below
    }

    const entry = zip.file(f.path);
    if (entry) await writeFileDir(target, await entry.async("nodebuffer"));
    applied.push(target);
  }

  return { applied, skipped, totalFiles: check.files.length };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string", short: "f", required: true },
      "data-dir": { type: "string", short: "d" },
      "on-conflict": { type: "string", default: "skip" },
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const bundle = await fs.readFile(values.file as string);

  if (!values["apply"]) {
    // Default: dry-run only.
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
    return;
  }

  // Apply mode.
  const dataDir = values["data-dir"] ?? process.env.TDAI_DATA_DIR;
  if (!dataDir) {
    console.error("❌ --apply 需要数据目录：请用 --data-dir 或设置 TDAI_DATA_DIR");
    process.exit(1);
  }
  const conflict = (values["on-conflict"] ?? "skip") as ConflictPolicy;
  if (conflict !== "skip" && conflict !== "rename" && conflict !== "replace") {
    console.error(`❌ --on-conflict 仅支持 skip|rename|replace（实际: ${conflict}）`);
    process.exit(1);
  }

  const result = await applyImport(bundle, dataDir, { conflict });
  for (const p of result.applied) {
    console.log(`   ✅ 写入 ${p}`);
  }
  for (const s of result.skipped) {
    console.log(`   ⏭  跳过 ${s.path} (${s.reason})`);
  }
  console.log(
    `✅ import 完成: 写入 ${result.applied.length} 个, 跳过 ${result.skipped.length} 个 ` +
    `(共 ${result.totalFiles} 个, conflict=${conflict})`,
  );
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
    console.error(`❌ import 失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
