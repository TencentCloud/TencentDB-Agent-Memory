/**
 * MongoClient connection pool, keyed by endpoint.
 *
 * Mirrors `MetadataStorePool`'s shared-client pattern: many per-instance
 * databases on the same Mongo endpoint share a single `MongoClient` (the driver
 * multiplexes over one connection pool), while each instance selects its own
 * `db(MongoConfig.database)`. Clients are created lazily with in-flight dedupe
 * so concurrent first-use of the same endpoint opens exactly one connection.
 */

import type { Db, Document, MongoClient, MongoClientOptions } from "mongodb";
import type { MongoConfig } from "../../instance-config-provider.js";
import { COLLECTIONS, sanitizeDbName } from "./collections.js";

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// ════════════════════════════════════════════════════════════════
// Cluster probe (connect-time 拨测)
//
// Topology and mongot are **cluster-level** attributes, so they are probed
// once per endpoint and cached next to the pooled client. FTS is a hard
// requirement of the store contract (sqlite/tcvdb both ship keyword search),
// so consumers fail fast when `mongot=false` instead of discovering a dead
// search path on the first query.
// ════════════════════════════════════════════════════════════════

/** Cluster topology derived from the `hello` response. */
export type MongoTopology = "standalone" | "replicaSet" | "sharded";

export interface MongoClusterProfile {
  topology: MongoTopology;
  /** Server version string from `buildInfo` (best-effort, may be ""). */
  version: string;
  maxWireVersion: number;
  /** Whether the deployment serves `$search`/`$vectorSearch` (mongot present). */
  mongot: boolean;
  probedAtMs: number;
}

/** `hello.msg === "isdbgrid"` ⇒ connected to mongos (sharded cluster). */
export function classifyHello(hello: { msg?: unknown; setName?: unknown }): MongoTopology {
  if (hello.msg === "isdbgrid") return "sharded";
  if (typeof hello.setName === "string" && hello.setName.length > 0) return "replicaSet";
  return "standalone";
}

function errorCode(err: unknown): number | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "number" ? c : undefined;
}

function errorCodeName(err: unknown): string {
  const n = (err as { codeName?: unknown } | null)?.codeName;
  return typeof n === "string" ? n : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * NamespaceNotFound (26): the server **understood** the search command but the
 * probed collection does not exist yet — which still proves mongot is present.
 */
export function isNamespaceMissing(err: unknown): boolean {
  return errorCode(err) === 26 || /NamespaceNotFound|ns not found/i.test(errorMessage(err));
}

/**
 * No-mongot markers, verified against real deployments:
 *   - 59 CommandNotFound / 115 CommandNotSupported (older mongod)
 *   - 40324 Location40324 "Unrecognized pipeline stage" (older mongod)
 *   - 31082 SearchNotEnabled (modern community mongod ≥ 7.0, verified on 8.x)
 *   - message-level "mongot"/"not enabled" markers (Atlas-side variants)
 */
export function isSearchUnsupported(err: unknown): boolean {
  const code = errorCode(err);
  if (code === 59 || code === 115 || code === 40324 || code === 31082) return true;
  if (errorCodeName(err) === "SearchNotEnabled") return true;
  return /no such command|unrecognized pipeline stage|not supported|search.{0,40}not.{0,10}enabled|mongot/i.test(
    errorMessage(err),
  );
}

/**
 * Probe mongot availability with two forms: the `listSearchIndexes` command
 * (7.0+) and the `$listSearchIndexes` aggregation stage (older mongot). A
 * mongot-enabled deployment understands both even before the collection exists;
 * a plain mongod rejects them outright. Auth/network errors are rethrown
 * (fail-loud) — only "unsupported" classifies as `false`.
 */
export async function probeMongot(db: Db, collection: string = COLLECTIONS.L0): Promise<boolean> {
  try {
    await db.command({ listSearchIndexes: collection });
    return true;
  } catch (err) {
    if (isNamespaceMissing(err)) return true;
    if (!isSearchUnsupported(err)) throw err;
    // Command form unsupported → try the aggregation-stage form.
  }
  try {
    await db.collection(collection).aggregate([{ $listSearchIndexes: {} }]).toArray();
    return true;
  } catch (err) {
    if (isNamespaceMissing(err)) return true;
    if (isSearchUnsupported(err)) return false;
    throw err;
  }
}

async function probeCluster(client: MongoClient, dbName: string): Promise<MongoClusterProfile> {
  const admin = client.db("admin");
  let hello: Document;
  try {
    hello = await admin.command({ hello: 1 });
  } catch {
    // Pre-4.4 servers lack `hello`; fall back to the legacy equivalent.
    hello = await admin.command({ isMaster: 1 });
  }
  let version = "";
  try {
    const buildInfo = await admin.command({ buildInfo: 1 });
    version = String(buildInfo.version ?? "");
  } catch {
    // best-effort; maxWireVersion from hello is the actual feature gate
  }
  const mongot = await probeMongot(client.db(dbName));
  return {
    topology: classifyHello(hello),
    version,
    maxWireVersion: Number(hello.maxWireVersion ?? 0),
    mongot,
    probedAtMs: Date.now(),
  };
}

/** Build a stable pool key. Auth may live in the URI or in user/password. */
function endpointKey(cfg: MongoConfig): string {
  return `${cfg.endpoint}\u0000${cfg.user}`;
}

/**
 * Client options for every pooled data-plane client.
 *
 * Write concern `w:1` (D15): memory data is derived and rebuildable, so
 * primary-ack is enough. The server-side implicit default since MongoDB 5.0
 * is `w:majority` — it buys rollback durability we don't need at real
 * replication-latency cost. Ordering and read-your-writes on the primary are
 * unaffected (w:1 is still acknowledged, just not replication-confirmed).
 *
 * Scope note: the metadata store (`src/metadata/store/factory.ts`) builds its
 * own clients and is NOT covered — its multi-document transactions keep the
 * server default.
 */
export function buildMongoClientOptions(cfg: MongoConfig): MongoClientOptions {
  const options: MongoClientOptions = { writeConcern: { w: 1 } };
  if (cfg.user) options.auth = { username: cfg.user, password: cfg.password };
  return options;
}

export class MongoClientPool {
  private clients = new Map<string, MongoClient>();
  private inflight = new Map<string, Promise<MongoClient>>();
  private profiles = new Map<string, MongoClusterProfile>();
  private profileInflight = new Map<string, Promise<MongoClusterProfile>>();
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Get (or lazily open) the shared MongoClient for this endpoint.
   * Concurrent callers for the same endpoint await the same connect Promise.
   */
  async getClient(cfg: MongoConfig): Promise<MongoClient> {
    const key = endpointKey(cfg);
    const existing = this.clients.get(key);
    if (existing) return existing;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const connectPromise = (async () => {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(cfg.endpoint, buildMongoClientOptions(cfg));
      await client.connect();
      this.clients.set(key, client);
      this.logger?.info?.(`[mongo-pool] connected endpoint (key=${key.split("\u0000")[0]})`);
      return client;
    })();

    this.inflight.set(key, connectPromise);
    try {
      return await connectPromise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Resolve the per-instance `Db` handle (shared client + sanitized db name). */
  async getDb(cfg: MongoConfig): Promise<Db> {
    const client = await this.getClient(cfg);
    return client.db(sanitizeDbName(cfg.database));
  }

  /**
   * Probe the cluster once per endpoint (in-flight deduped) and cache the
   * profile. The mongot probe runs against the **configured** database because
   * search commands are namespace-scoped and auth may be db-scoped.
   */
  async getClusterProfile(cfg: MongoConfig): Promise<MongoClusterProfile> {
    const key = endpointKey(cfg);
    const cached = this.profiles.get(key);
    if (cached) return cached;

    const pending = this.profileInflight.get(key);
    if (pending) return pending;

    const probePromise = (async () => {
      const client = await this.getClient(cfg);
      const profile = await probeCluster(client, sanitizeDbName(cfg.database));
      this.profiles.set(key, profile);
      this.logger?.info?.(
        `[mongo-pool] cluster profile: topology=${profile.topology} mongot=${profile.mongot} ` +
          `version=${profile.version || "?"} (endpoint=${key.split("\u0000")[0]})`,
      );
      return profile;
    })();

    this.profileInflight.set(key, probePromise);
    try {
      return await probePromise;
    } finally {
      this.profileInflight.delete(key);
    }
  }

  /** Close all pooled clients (process shutdown). */
  async closeAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.inflight.clear();
    this.profiles.clear();
    this.profileInflight.clear();
    await Promise.allSettled(clients.map((c) => c.close()));
    this.logger?.info?.(`[mongo-pool] closed ${clients.length} client(s)`);
  }
}

/**
 * Process-wide shared pool. The gateway constructs one StorePool per process;
 * memory + skill stores share the same underlying MongoClient per endpoint via
 * this singleton so we never open duplicate connection pools.
 */
let _sharedPool: MongoClientPool | null = null;

export function getSharedMongoClientPool(logger?: Logger): MongoClientPool {
  if (!_sharedPool) _sharedPool = new MongoClientPool(logger);
  return _sharedPool;
}

/** Testing helper: reset the shared pool (does not close existing clients). */
export function _resetSharedMongoClientPoolForTest(): void {
  _sharedPool = null;
}
