/**
 * Enterprise WeCom-name identity store.
 *
 * The mapping key is SHA-256(apiKey), so neither ClickHouse nor this module's
 * cache ever holds the caller's raw credential after lookup has begun.
 */
import { createHash } from "node:crypto";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

interface CacheEntry {
  name: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();
const ensuredTables = new Set<string>();

function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function safeTable(table: string): string {
  // ClickHouse identifiers cannot be query parameters. Restricting the value
  // keeps the YAML setting from becoming a SQL injection surface.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error("wecomIdentity.table must be a simple ClickHouse identifier");
  }
  return table;
}

async function withClient<T>(config: ProxyConfig, fn: (client: import("@clickhouse/client").ClickHouseClient) => Promise<T>): Promise<T> {
  const { createClient } = await import("@clickhouse/client");
  const client = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
    database: config.clickhouse.database,
    request_timeout: 5_000,
  });
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function ensureTable(config: ProxyConfig): Promise<string> {
  if (!config.clickhouse.enabled || !config.clickhouse.url) {
    throw new Error("ClickHouse must be enabled when wecomIdentity is enabled");
  }
  const table = safeTable(config.wecomIdentity?.table ?? "api_key_wecom_names");
  const identity = `${config.clickhouse.url}/${config.clickhouse.database}/${table}`;
  if (ensuredTables.has(identity)) return table;
  await withClient(config, async (client) => {
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS ${table} (
        api_key_hash FixedString(64),
        wecom_name String,
        created_at DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3),
        updated_at DateTime64(3, 'Asia/Shanghai') DEFAULT now64(3)
      ) ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY api_key_hash`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
  });
  ensuredTables.add(identity);
  return table;
}

/**
 * Resolve a name from the positive in-memory cache or ClickHouse.
 * A missing name is deliberately not negatively cached: another proxy node may
 * receive and persist the interactive answer immediately after this request.
 */
export async function resolveWecomName(config: ProxyConfig, apiKey: string): Promise<string | null> {
  const settings = config.wecomIdentity;
  if (!settings?.enabled) return null;
  if (!apiKey) throw new Error("an API key is required for WeCom identity");
  const hash = keyHash(apiKey);
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  if (cached) cache.delete(hash);

  const pending = inFlight.get(hash);
  if (pending) return pending;
  const lookup = (async () => {
    const table = await ensureTable(config);
    const rows = await withClient(config, async (client) => {
      const result = await client.query({
        query: `SELECT wecom_name FROM ${table} WHERE api_key_hash = {hash:String} ORDER BY updated_at DESC LIMIT 1`,
        query_params: { hash },
        format: "JSONEachRow",
      });
      return result.json<{ wecom_name?: string }>();
    });
    const name = typeof rows[0]?.wecom_name === "string" ? rows[0].wecom_name.trim() : "";
    if (!name) return null;
    cache.set(hash, { name, expiresAt: Date.now() + settings.cacheTtlMs });
    return name;
  })();
  inFlight.set(hash, lookup);
  try {
    return await lookup;
  } finally {
    inFlight.delete(hash);
  }
}

/** Validate, persist, and cache a name supplied by the user's native tool UI. */
export async function saveWecomName(config: ProxyConfig, apiKey: string, submittedName: string): Promise<string> {
  const settings = config.wecomIdentity;
  if (!settings?.enabled) return "";
  const name = submittedName.trim().replace(/\s+/g, " ");
  const maxNameLength = settings.maxNameLength;
  if (!name || name.length > maxNameLength) {
    throw new Error(`企业微信名称不能为空且不能超过 ${maxNameLength} 个字符`);
  }
  if (!apiKey) throw new Error("an API key is required for WeCom identity");
  const hash = keyHash(apiKey);
  const table = await ensureTable(config);
  await withClient(config, async (client) => {
    await client.insert({
      table,
      // Let ClickHouse's `DEFAULT now64(3)` populate updated_at. ISO strings
      // (`2026-...T...Z`) are not accepted by DateTime64 JSONEachRow parsing.
      values: [{ api_key_hash: hash, wecom_name: name }],
      format: "JSONEachRow",
    });
  });
  cache.set(hash, { name, expiresAt: Date.now() + settings.cacheTtlMs });
  log.info("wecom_identity.saved", { apiKeyHashPrefix: hash.slice(0, 8) });
  return name;
}

/** Test-only reset. */
export function __resetWecomIdentityForTests(): void {
  cache.clear();
  inFlight.clear();
  ensuredTables.clear();
}
