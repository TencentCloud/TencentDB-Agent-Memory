import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { listLocalProfiles } from "../../src/core/profile/profile-sync.js";
import { PgMemoryStore } from "../../src/core/store/postgres.js";
import { VectorStore, type L0RecordRow, type L1RecordRow } from "../../src/core/store/sqlite.js";
import type { L0Record, ProfileSyncRecord } from "../../src/core/store/types.js";
import type { PostgresConfig } from "../../src/config.js";

const TAG = "[memory-tdai][migrate-postgres]";
const DEFAULT_PAGE_SIZE = 100;
const ALL_LAYERS = ["l0", "l1", "l2", "l3"] as const;

type Layer = (typeof ALL_LAYERS)[number];

interface Options {
  pluginDataDir: string;
  sqlitePath: string;
  layers: Layer[];
  dryRun: boolean;
  yes: boolean;
  failIfTargetNonempty: boolean;
  pageSize: number;
  embeddingDimensions: number;
  postgres: PostgresConfig;
}

export interface MigrationSummary {
  dryRun: boolean;
  layers: Layer[];
  source: {
    sqlitePath: string;
    l0Count: number;
    l1Count: number;
    profileCount: number;
  };
  target: {
    host: string;
    port: number;
    database: string;
    schema: string;
    l0Count: number;
    l1Count: number;
    profileCount: number;
  };
  migrated: {
    l0: number;
    l1: number;
    profiles: number;
  };
}

export async function runMigrationCli(argv: string[]): Promise<MigrationSummary> {
  const options = parseOptions(argv);
  await ensureReadablePath(options.sqlitePath, "SQLite database");

  const source = new VectorStore(options.sqlitePath, 0);
  const target = new PgMemoryStore(options.postgres, options.embeddingDimensions);

  try {
    source.init();
    const initResult = await target.init({
      provider: "migration",
      model: "metadata-only",
    });
    if (target.isDegraded()) {
      throw new Error(`PostgreSQL target is degraded: ${initResult.reason ?? "unknown error"}`);
    }

    const profileRecords = await listLocalProfiles(options.pluginDataDir);
    const sourceCounts = {
      l0Count: source.countL0(),
      l1Count: source.countL1(),
      profileCount: profileRecords.length,
    };

    if (options.failIfTargetNonempty) {
      const [l0, l1, profiles] = await Promise.all([
        target.countL0(),
        target.countL1(),
        target.pullProfiles().then((rows) => rows.length),
      ]);
      if (l0 > 0 || l1 > 0 || profiles > 0) {
        throw new Error(`Target PostgreSQL store is not empty (L0=${l0}, L1=${l1}, profiles=${profiles})`);
      }
    }

    if (options.dryRun) {
      return buildSummary(options, sourceCounts, { l0: 0, l1: 0, profiles: 0 }, target);
    }

    if (!options.yes) {
      throw new Error("Refusing to migrate without --yes. Re-run with --dry-run first, then add --yes to apply.");
    }

    const migrated = {
      l0: options.layers.includes("l0") ? await migrateL0(source, target, options.pageSize) : 0,
      l1: options.layers.includes("l1") ? await migrateL1(source, target, options.pageSize) : 0,
      profiles: 0,
    };

    if (options.layers.includes("l2") || options.layers.includes("l3")) {
      const selected = profileRecords.filter((profile) => options.layers.includes(profile.type));
      await target.syncProfiles(selected.map((profile): ProfileSyncRecord => ({ ...profile, baselineVersion: 0 })));
      migrated.profiles = selected.length;
    }

    return buildSummary(options, sourceCounts, migrated, target);
  } finally {
    source.close();
    target.close();
  }
}

function parseOptions(argv: string[]): Options {
  const parsed = parseArgs({
    args: argv,
    options: {
      "plugin-data-dir": { type: "string" },
      "sqlite-path": { type: "string" },
      layers: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "allow-nonempty-target": { type: "boolean", default: false },
      "page-size": { type: "string" },
      "embedding-dimensions": { type: "string" },
      "pg-host": { type: "string" },
      "pg-port": { type: "string" },
      "pg-database": { type: "string" },
      "pg-user": { type: "string" },
      "pg-password": { type: "string" },
      "pg-schema": { type: "string" },
      "pg-ssl": { type: "boolean", default: false },
      "pg-pool-max": { type: "string" },
      "pg-statement-timeout-ms": { type: "string" },
      "pg-text-config": { type: "string" },
      "pg-vector-index": { type: "string" },
    },
    allowPositionals: false,
  });

  const values = parsed.values;
  const pluginDataDir = stringOption(values, "plugin-data-dir") ?? path.join(process.cwd(), ".memory-tdai");
  const sqlitePath = stringOption(values, "sqlite-path") ?? path.join(pluginDataDir, "vectors.db");
  const embeddingDimensions = numberOption(values, "embedding-dimensions", 0);
  const vectorIndex = parseVectorIndex(stringOption(values, "pg-vector-index") ?? "hnsw");

  return {
    pluginDataDir,
    sqlitePath,
    layers: parseLayers(stringOption(values, "layers")),
    dryRun: Boolean(values["dry-run"]),
    yes: Boolean(values.yes),
    failIfTargetNonempty: !Boolean(values["allow-nonempty-target"]),
    pageSize: numberOption(values, "page-size", DEFAULT_PAGE_SIZE),
    embeddingDimensions,
    postgres: {
      host: stringOption(values, "pg-host") ?? "127.0.0.1",
      port: numberOption(values, "pg-port", 5432),
      database: stringOption(values, "pg-database") ?? "postgres",
      user: stringOption(values, "pg-user") ?? "postgres",
      password: stringOption(values, "pg-password"),
      schema: stringOption(values, "pg-schema") ?? "agent_memory",
      ssl: Boolean(values["pg-ssl"]),
      poolMax: numberOption(values, "pg-pool-max", 5),
      statementTimeoutMs: numberOption(values, "pg-statement-timeout-ms", 10000),
      textConfig: normalizeTextConfig(stringOption(values, "pg-text-config")),
      vectorIndex,
      useVectorScale: vectorIndex === "diskann",
    },
  };
}

async function migrateL1(source: VectorStore, target: PgMemoryStore, pageSize: number): Promise<number> {
  let cursor = "";
  let migrated = 0;
  while (true) {
    const rows = source.queryL1RecordsCursor(cursor, pageSize);
    if (rows.length === 0) break;
    for (const record of rows.map(mapL1RowToMemoryRecord)) {
      if (!(await target.upsertL1(record))) throw new Error(`Failed to migrate L1 record ${record.id}`);
    }
    migrated += rows.length;
    cursor = rows[rows.length - 1].record_id;
    log(`L1 migrated ${migrated}`);
    if (rows.length < pageSize) break;
  }
  return migrated;
}

async function migrateL0(source: VectorStore, target: PgMemoryStore, pageSize: number): Promise<number> {
  let cursor = "";
  let migrated = 0;
  while (true) {
    const rows = source.queryL0RecordsCursor(cursor, pageSize);
    if (rows.length === 0) break;
    for (const record of rows.map(mapL0RowToRecord)) {
      if (!(await target.upsertL0(record))) throw new Error(`Failed to migrate L0 record ${record.id}`);
    }
    migrated += rows.length;
    cursor = rows[rows.length - 1].record_id;
    log(`L0 migrated ${migrated}`);
    if (rows.length < pageSize) break;
  }
  return migrated;
}

async function buildSummary(
  options: Options,
  source: { l0Count: number; l1Count: number; profileCount: number },
  migrated: { l0: number; l1: number; profiles: number },
  target: PgMemoryStore,
): Promise<MigrationSummary> {
  const [targetL0, targetL1, targetProfiles] = await Promise.all([
    target.countL0(),
    target.countL1(),
    target.pullProfiles().then((rows) => rows.length),
  ]);

  return {
    dryRun: options.dryRun,
    layers: options.layers,
    source: {
      sqlitePath: options.sqlitePath,
      l0Count: source.l0Count,
      l1Count: source.l1Count,
      profileCount: source.profileCount,
    },
    target: {
      host: options.postgres.host,
      port: options.postgres.port,
      database: options.postgres.database,
      schema: options.postgres.schema,
      l0Count: targetL0,
      l1Count: targetL1,
      profileCount: targetProfiles,
    },
    migrated,
  };
}

function mapL1RowToMemoryRecord(row: L1RecordRow): MemoryRecord {
  const timestamps = [...new Set([row.timestamp_str, row.timestamp_start, row.timestamp_end].filter(Boolean))];
  const fallbackIso = row.updated_time || row.created_time || row.timestamp_end || row.timestamp_str || new Date(0).toISOString();
  return {
    id: row.record_id,
    content: row.content,
    type: row.type as MemoryRecord["type"],
    priority: row.priority,
    scene_name: row.scene_name,
    source_message_ids: [],
    metadata: safeParseMetadata(row.metadata_json),
    timestamps,
    createdAt: row.created_time || fallbackIso,
    updatedAt: row.updated_time || fallbackIso,
    sessionKey: row.session_key || "",
    sessionId: row.session_id || "",
  };
}

function mapL0RowToRecord(row: L0RecordRow): L0Record {
  return {
    id: row.record_id,
    sessionKey: row.session_key,
    sessionId: row.session_id || "",
    role: row.role,
    messageText: row.message_text,
    recordedAt: row.recorded_at || "",
    timestamp: row.timestamp ?? 0,
  };
}

function safeParseMetadata(raw: string): Record<string, never> | Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseLayers(raw: string | undefined): Layer[] {
  if (!raw) return [...ALL_LAYERS];
  const layers = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
  const invalid = layers.filter((layer) => !ALL_LAYERS.includes(layer as Layer));
  if (invalid.length > 0) throw new Error(`Unsupported layer(s): ${invalid.join(", ")}`);
  return layers as Layer[];
}

function parseVectorIndex(raw: string): PostgresConfig["vectorIndex"] {
  if (raw === "none" || raw === "hnsw" || raw === "ivfflat" || raw === "diskann") return raw;
  throw new Error(`Unsupported --pg-vector-index value: ${raw}`);
}

function stringOption(values: Record<string, string | boolean | undefined>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTextConfig(value: string | undefined): string {
  if (!value) return "simple";
  return value.toLowerCase() === "jieba" ? "public.jiebacfg" : value;
}

function numberOption(values: Record<string, string | boolean | undefined>, key: string, fallback: number): number {
  const raw = stringOption(values, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${key}: ${raw}`);
  return value;
}

async function ensureReadablePath(filePath: string, label: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${label} does not exist or is not accessible: ${filePath}`);
  }
}

function log(message: string): void {
  process.stderr.write(`${TAG} ${message}\n`);
}
