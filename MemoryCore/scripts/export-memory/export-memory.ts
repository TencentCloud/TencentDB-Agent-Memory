#!/usr/bin/env node
/**
 * memory export — export memory assets to a portable ZIP bundle.
 *
 * Step 1 of issue #779: manifest/schema + read-only export of chat-memory
 * (L0 conversations + L1 memory records). Import / restore lands in a later
 * step.
 *
 * Usage:
 *   node ./bin/export-memory.mjs --data-dir <dir> --out ./backup.zip
 *   node ./bin/export-memory.mjs --data-dir <dir> --out ./backup.zip \
 *       --instance-id <id> --skip-records
 *
 * Data layout read from the data directory:
 *   conversations/YYYY-MM-DD.jsonl   (L0)
 *   records/YYYY-MM-DD.jsonl         (L1)
 *
 * Output ZIP:
 *   manifest.json
 *   conversations/…  records/…
 *
 * manifest.json is validated against exportManifestSchema before writing
 * (see manifest.ts).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

import {
  MANIFEST_SCHEMA_VERSION,
  validateManifest,
  type ExportManifest,
} from "./manifest.js";

async function sha256(content: Buffer): Promise<string> {
  return createHash("sha256").update(content).digest("hex");
}

interface CollectedFile {
  path: string;
  checksum: string;
  size: number;
}

/**
 * Add every non-directory file under `dirPath` to the ZIP under `prefix`,
 * returning file entries (path + checksum + size). Missing dir → empty list.
 */
async function collectDir(
  zip: JSZip,
  dirPath: string,
  prefix: string,
): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return out; // directory absent → no files for this namespace
  }
  entries.sort();
  for (const entry of entries) {
    const full = path.join(dirPath, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) continue;
    const rel = `${prefix}/${entry}`;
    const content = await fs.readFile(full);
    zip.file(rel, content);
    out.push({ path: rel, checksum: `sha256:${await sha256(content)}`, size: content.length });
  }
  return out;
}

export interface ExportOptions {
  /** Root data directory (contains conversations/ and records/). */
  dataDir: string;
  /** Instance id recorded in the manifest (default "default"). */
  instanceId?: string;
  /** Whether to include L1 records/ (default true). */
  includeRecords?: boolean;
}

export interface ExportResult {
  manifest: ExportManifest;
  /** ZIP archive as a Buffer. */
  zip: Buffer;
}

/**
 * Build a portable chat-memory export bundle from a data directory.
 * Returns the validated manifest + the ZIP buffer (not yet written to disk).
 */
export async function buildExportBundle(opts: ExportOptions): Promise<ExportResult> {
  const zip = new JSZip();

  const convFiles = await collectDir(zip, path.join(opts.dataDir, "conversations"), "conversations");
  const recordFiles =
    opts.includeRecords === false
      ? []
      : await collectDir(zip, path.join(opts.dataDir, "records"), "records");

  const files = [...convFiles, ...recordFiles];
  if (files.length === 0) {
    throw new Error("未找到可导出的记忆文件（conversations/ 或 records/ 为空）");
  }

  const assetId = opts.instanceId ?? "default";
  const manifest: ExportManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    ...(opts.instanceId ? { source_instance_id: opts.instanceId } : {}),
    assets: [{ type: "chat-memory", id: assetId, files }],
  };

  // Self-check: the manifest must round-trip through the schema.
  validateManifest(manifest);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { manifest, zip: buf };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", short: "d" },
      "out": { type: "string", short: "o", required: true },
      "instance-id": { type: "string" },
      "skip-records": { type: "boolean", default: false },
    },
  });

  const dataDir = values["data-dir"] ?? process.env.TDAI_DATA_DIR;
  if (!dataDir) {
    console.error("❌ 缺少数据目录：请用 --data-dir 或设置 TDAI_DATA_DIR");
    process.exit(1);
  }

  const { manifest, zip } = await buildExportBundle({
    dataDir,
    instanceId: values["instance-id"],
    includeRecords: values["skip-records"] ? false : true,
  });

  const outPath = values["out"] as string;
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, zip);

  const files = manifest.assets[0].files;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  console.log(`✅ 导出完成 → ${outPath}`);
  console.log(`   资产: chat-memory (id=${manifest.assets[0].id})`);
  console.log(`   文件: ${files.length} 个 (${totalBytes} bytes)`);
  console.log(`   schema_version: ${manifest.schema_version}`);
}

// Run the CLI only when invoked directly (node dist/export-memory.js) or via
// the thin bin launcher (bin/export-memory.mjs imports this module). Tests and
// other importers get the pure buildExportBundle without side effects.
const isCliEntry = process.argv[1] !== undefined && (
  import.meta.url === pathToFileURL(process.argv[1]).href
  || process.argv[1].endsWith("bin/export-memory.mjs")
);
if (isCliEntry) {
  main().catch((err) => {
    console.error(`❌ 导出失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
