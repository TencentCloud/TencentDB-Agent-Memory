#!/usr/bin/env node
/**
 * memory knowledge export — export llm-wiki / code-graph assets to a
 * portable ZIP bundle (issue #779, MemoryKnowledge side).
 *
 * Chat-memory + skill export live in MemoryCore (scripts/export-memory); the
 * wiki / code-graph assets live in this module's data dir, so they get their
 * own exporter. The bundle format is identical to MemoryCore's export
 * (manifest.json with schema_version + assets[].type + per-file sha256).
 *
 * Usage:
 *   node ./bin/export-knowledge.mjs --data-dir ./data --out ./knowledge-backup.zip
 *   node ./bin/export-knowledge.mjs --data-dir ./data --out ./kb.zip --asset llm-wiki
 *
 * Data layout read from the data directory:
 *   knowledge.db                                        (SQLite metadata)
 *   <service_id>/<team_id>/<wiki_id>/                   (wiki material + index.db)
 *   <service_id>/<team_id>/<code_graph_id>/             (code-graph index)
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

const MANIFEST_SCHEMA_VERSION = "1.0.0";

interface FileEntry {
  path: string;
  checksum: string;
  size: number;
}

export interface KnowledgeExportOptions {
  /** Root data directory (contains knowledge.db + per-tenant dirs). */
  dataDir: string;
  /** knowledge.db path (default <dataDir>/knowledge.db). */
  dbPath?: string;
  /** Instance id recorded in the manifest (default "default"). */
  instanceId?: string;
  /** Which assets to export: "llm-wiki" | "code-graph" | "all" (default all). */
  assets?: ("llm-wiki" | "code-graph")[];
}

export interface KnowledgeExportResult {
  manifest: {
    schema_version: string;
    created_at: string;
    source_instance_id?: string;
    assets: {
      type: string;
      id: string;
      files: FileEntry[];
    }[];
  };
  zip: Buffer;
}

async function sha256(content: Buffer): Promise<string> {
  return createHash("sha256").update(content).digest("hex");
}

/** Recursively add every file under dirPath to the ZIP under prefix. */
async function collectDir(
  zip: JSZip,
  dirPath: string,
  prefix: string,
  out: FileEntry[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // directory absent → nothing to collect
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dirPath, e.name);
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      await collectDir(zip, full, rel, out);
    } else {
      const content = await fs.readFile(full);
      zip.file(rel, content);
      out.push({ path: rel, checksum: `sha256:${await sha256(content)}`, size: content.length });
    }
  }
}

/** Read all rows of a knowledge_* table as plain objects. */
function readTableRows(
  dbPath: string,
  table: "knowledge_wiki" | "knowledge_code_graph",
): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

export async function buildKnowledgeBundle(
  opts: KnowledgeExportOptions,
): Promise<KnowledgeExportResult> {
  const zip = new JSZip();
  const dataDir = path.resolve(opts.dataDir);
  const dbPath = opts.dbPath ?? path.join(dataDir, "knowledge.db");
  const assetId = opts.instanceId ?? "default";
  const kinds = opts.assets ?? ["llm-wiki", "code-graph"];
  const manifestAssets: { type: string; id: string; files: FileEntry[] }[] = [];

  if (kinds.includes("llm-wiki")) {
    const rows = readTableRows(dbPath, "knowledge_wiki");
    if (rows.length > 0) {
      const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
      zip.file("knowledge_wiki.jsonl", jsonl);
      const files: FileEntry[] = [{
        path: "knowledge_wiki.jsonl",
        checksum: `sha256:${await sha256(Buffer.from(jsonl))}`,
        size: Buffer.byteLength(jsonl),
      }];
      for (const row of rows) {
        if (typeof row.service_id !== "string" || typeof row.team_id !== "string"
          || typeof row.wiki_id !== "string") continue;
        await collectDir(
          zip,
          path.join(dataDir, row.service_id, row.team_id, row.wiki_id),
          `wiki/${row.service_id}/${row.team_id}/${row.wiki_id}`,
          files,
        );
      }
      manifestAssets.push({ type: "llm-wiki", id: assetId, files });
    }
  }

  if (kinds.includes("code-graph")) {
    const rows = readTableRows(dbPath, "knowledge_code_graph");
    if (rows.length > 0) {
      const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
      zip.file("knowledge_code_graph.jsonl", jsonl);
      const files: FileEntry[] = [{
        path: "knowledge_code_graph.jsonl",
        checksum: `sha256:${await sha256(Buffer.from(jsonl))}`,
        size: Buffer.byteLength(jsonl),
      }];
      for (const row of rows) {
        if (typeof row.service_id !== "string" || typeof row.team_id !== "string"
          || typeof row.code_graph_id !== "string") continue;
        await collectDir(
          zip,
          path.join(dataDir, row.service_id, row.team_id, row.code_graph_id),
          `code-graph/${row.service_id}/${row.team_id}/${row.code_graph_id}`,
          files,
        );
      }
      manifestAssets.push({ type: "code-graph", id: assetId, files });
    }
  }

  if (manifestAssets.length === 0) {
    throw new Error("未找到可导出的知识资产（knowledge_wiki / knowledge_code_graph 为空）");
  }

  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    ...(opts.instanceId ? { source_instance_id: opts.instanceId } : {}),
    assets: manifestAssets,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { manifest, zip: buf };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", short: "d" },
      "db-path": { type: "string" },
      "out": { type: "string", short: "o", required: true },
      "instance-id": { type: "string" },
      asset: { type: "string", default: "all" },
    },
  });

  const dataDir = values["data-dir"] ?? process.env.KNOWLEDGE_DATA_DIR ?? "./data";
  const raw = (values["asset"] ?? "all") as string;
  const kinds = raw === "all"
    ? undefined
    : [raw as "llm-wiki" | "code-graph"];

  const { manifest, zip } = await buildKnowledgeBundle({
    dataDir,
    dbPath: values["db-path"],
    instanceId: values["instance-id"],
    assets: kinds,
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

// Run the CLI only when invoked directly or via the thin bin launcher.
const isCliEntry = process.argv[1] !== undefined && (
  import.meta.url === pathToFileURL(process.argv[1]).href
  || process.argv[1].endsWith("bin/export-knowledge.mjs")
);
if (isCliEntry) {
  main().catch((err) => {
    console.error(`❌ 导出失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
