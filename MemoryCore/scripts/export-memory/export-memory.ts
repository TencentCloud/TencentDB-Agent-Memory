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
  type ExportAsset,
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

export type ExportAssetKind = "chat-memory" | "skill";

export interface ExportOptions {
  /** Root data directory (contains conversations/, records/, vectors.db). */
  dataDir: string;
  /** Instance id recorded in the manifest (default "default"). */
  instanceId?: string;
  /** Whether to include L1 records/ for chat-memory (default true). */
  includeRecords?: boolean;
  /** Which assets to export. Default: all supported. */
  assets?: ExportAssetKind[];
}

/**
 * Collect the "skill" asset: head skill rows from the `skills` table in
 * vectors.db, plus each skill's resource files from its storage_dir.
 * Returns [] when vectors.db is absent or has no skills.
 */
async function collectSkillAsset(zip: JSZip, dataDir: string): Promise<CollectedFile[]> {
  const dbPath = path.join(dataDir, "vectors.db");

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return [];
  }

  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return []; // no vectors.db → no skill data
  }

  try {
    const rows = db.prepare("SELECT * FROM skills WHERE is_head = 1").all() as Record<string, unknown>[];
    if (rows.length === 0) return [];

    const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
    zip.file("skills.jsonl", jsonl);
    const files: CollectedFile[] = [{
      path: "skills.jsonl",
      checksum: `sha256:${await sha256(Buffer.from(jsonl))}`,
      size: Buffer.byteLength(jsonl),
    }];

    // Pack each skill's resource directory as skills/resources/<n>/<file>.
    const storageDirs = [...new Set(
      rows.map((r) => (typeof r.storage_dir === "string" ? r.storage_dir : "")).filter(Boolean),
    )];
    for (let i = 0; i < storageDirs.length; i++) {
      const res = await collectDir(zip, storageDirs[i], `skills/resources/${i}`);
      files.push(...res);
    }
    return files;
  } finally {
    db.close();
  }
}

export interface ExportResult {
  manifest: ExportManifest;
  /** ZIP archive as a Buffer. */
  zip: Buffer;
}

/**
 * Build a portable export bundle from a data directory.
 * Returns the validated manifest + the ZIP buffer (not yet written to disk).
 */
export async function buildExportBundle(opts: ExportOptions): Promise<ExportResult> {
  const zip = new JSZip();
  const assetId = opts.instanceId ?? "default";
  const kinds: ExportAssetKind[] = opts.assets ?? ["chat-memory", "skill"];
  const assets: ExportAsset[] = [];

  if (kinds.includes("chat-memory")) {
    const convFiles = await collectDir(zip, path.join(opts.dataDir, "conversations"), "conversations");
    const recordFiles =
      opts.includeRecords === false
        ? []
        : await collectDir(zip, path.join(opts.dataDir, "records"), "records");
    const files = [...convFiles, ...recordFiles];
    if (files.length > 0) {
      assets.push({ type: "chat-memory", id: assetId, files });
    }
  }

  if (kinds.includes("skill")) {
    const skillFiles = await collectSkillAsset(zip, opts.dataDir);
    if (skillFiles.length > 0) {
      assets.push({ type: "skill", id: assetId, files: skillFiles });
    }
  }

  if (assets.length === 0) {
    throw new Error("未找到可导出的记忆资产（conversations/、records/ 或 skills 为空）");
  }

  const manifest: ExportManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    ...(opts.instanceId ? { source_instance_id: opts.instanceId } : {}),
    assets,
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
      asset: { type: "string", default: "all" },
    },
  });

  const dataDir = values["data-dir"] ?? process.env.TDAI_DATA_DIR;
  if (!dataDir) {
    console.error("❌ 缺少数据目录：请用 --data-dir 或设置 TDAI_DATA_DIR");
    process.exit(1);
  }

  const rawAssets = (values["asset"] ?? "all") as string;
  const assetKinds: ExportAssetKind[] | undefined =
    rawAssets === "all" ? undefined : [rawAssets as ExportAssetKind];

  const { manifest, zip } = await buildExportBundle({
    dataDir,
    instanceId: values["instance-id"],
    includeRecords: values["skip-records"] ? false : true,
    assets: assetKinds,
  });

  const outPath = values["out"] as string;
  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, zip);

  const totalBytes = manifest.assets.reduce(
    (sum, a) => sum + a.files.reduce((s, f) => s + f.size, 0),
    0,
  );
  const totalFiles = manifest.assets.reduce((sum, a) => sum + a.files.length, 0);
  console.log(`✅ 导出完成 → ${outPath}`);
  for (const asset of manifest.assets) {
    console.log(`   资产: ${asset.type} (id=${asset.id}, files=${asset.files.length})`);
  }
  console.log(`   文件: ${totalFiles} 个 (${totalBytes} bytes)`);
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
