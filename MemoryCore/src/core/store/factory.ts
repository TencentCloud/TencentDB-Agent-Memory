/**
 * Store Factory — creates the appropriate storage backend and embedding service
 * based on plugin configuration.
 *
 * Supports:
 * - "sqlite" (default): local SQLite + sqlite-vec + FTS5
 * - "tcvdb": Tencent Cloud VectorDB (server-side embedding + hybridSearch)
 * - "postgres": PostgreSQL + pgvector + tsvector (application-side embedding)
 *
 * Both backends ship with core — TCVDB is a vendor-provided store that has
 * always been part of the open-source surface of this plugin (matches the
 * historical behavior prior to the open-source repackaging).
 */

import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite/memory-store.js";
import { TcvdbMemoryStore } from "./tcvdb/memory-store.js";
import { MongoMemoryStore } from "./mongodb/memory-store.js";
import { PgMemoryStore } from "./pg-store.js";
import { getSharedMongoClientPool } from "./mongodb/client-pool.js";
import { readMongoEnvConfig } from "../../utils/env-config.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import type { EmbeddingService } from "./embedding.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";

// Re-export for convenience
export type { IMemoryStore, IEmbeddingService, StoreLogger, BM25LocalEncoder };

const TAG = "[memory-tdai][factory]";

export interface StoreBundle {
  store: IMemoryStore;
  embedding: IEmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
  /** Snapshot of current store config for manifest writing. */
  storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

/**
 * Create the storage backend, embedding service, and optional BM25 encoder
 * based on plugin configuration.
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(
  config: MemoryTdaiConfig,
  options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
  const { logger } = options;

  // ── BM25 local encoder ──
  const bm25Encoder = createBM25Encoder(config.bm25, logger);

  switch (config.storeBackend) {
    case "tcvdb": {
      const tcvdbCfg = config.tcvdb;
      if (!tcvdbCfg.url || !tcvdbCfg.apiKey) {
        throw new Error(`${TAG} TCVDB backend requires tcvdb.url and tcvdb.apiKey`);
      }
      if (!tcvdbCfg.database) {
        throw new Error(`${TAG} TCVDB backend requires tcvdb.database — please set a unique database name in your openclaw.json plugin config`);
      }
      const database = tcvdbCfg.database;

      const store = new TcvdbMemoryStore({
        url: tcvdbCfg.url,
        username: tcvdbCfg.username,
        apiKey: tcvdbCfg.apiKey,
        database,
        embeddingEnabled: tcvdbCfg.embeddingEnabled,
        embeddingModel: tcvdbCfg.embeddingModel,
        timeout: tcvdbCfg.timeout,
        caPemPath: tcvdbCfg.caPemPath,
        logger,
        bm25Encoder: bm25Encoder ?? undefined,
      });

      logger?.debug?.(
        `${TAG} Store created: backend=tcvdb, database=${database}, ` +
        `embedding=${tcvdbCfg.embeddingEnabled ? `enabled(${tcvdbCfg.embeddingModel})` : "disabled"}, ` +
        `bm25=${bm25Encoder ? "enabled" : "disabled"}`,
      );

      return {
        store,
        embedding: new NoopEmbeddingService(),
        bm25Encoder,
        storeSnapshot: {
          type: "tcvdb",
          tcvdbUrl: tcvdbCfg.url,
          tcvdbDatabase: database,
          tcvdbAlias: tcvdbCfg.alias || undefined,
        },
      };
    }

    case "mongodb": {
      // Singleton/core path Mongo backend. Connection info comes from
      // MONGODB_* env (standalone) — mirrors how the gateway's StorePool
      // resolves per-instance Mongo config. Native mongot/BM25 → no local
      // embedding or bm25 encoder.
      const mongoConfig = readMongoEnvConfig();
      if (!mongoConfig.endpoint || !mongoConfig.database) {
        throw new Error(`${TAG} mongodb backend requires MONGODB_ENDPOINT and MONGODB_DATABASE`);
      }
      const store = new MongoMemoryStore({
        pool: getSharedMongoClientPool(logger),
        mongoConfig,
        logger,
      });

      logger?.debug?.(
        `${TAG} Store created: backend=mongodb, endpoint=${mongoConfig.endpoint}, database=${mongoConfig.database}`,
      );

      return {
        store,
        embedding: new NoopEmbeddingService(),
        storeSnapshot: {
          type: "mongodb",
          mongoEndpoint: mongoConfig.endpoint,
          mongoDatabase: mongoConfig.database,
        },
      };
    }

    case "postgres": {
      // PostgreSQL backend: pgvector (cosine) + tsvector FTS behind the
      // standard IMemoryStore interface. Tables/extensions are created by
      // init(). Embedding is computed application-side (same as sqlite).
      const pgCfg = config.postgres;
      if (!pgCfg || !pgCfg.connectionString) {
        throw new Error(`${TAG} PostgreSQL backend requires postgres.connectionString`);
      }
      let pgEmbeddingService: EmbeddingService | undefined;
      if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.provider !== "none" && config.embedding.apiKey) {
        pgEmbeddingService = createEmbeddingService({
          provider: config.embedding.provider,
          baseUrl: config.embedding.baseUrl,
          apiKey: config.embedding.apiKey,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          sendDimensions: config.embedding.sendDimensions,
          maxInputChars: config.embedding.maxInputChars,
        }, logger);
      }
      const pgDims = config.embedding.dimensions;
      const store = new PgMemoryStore({
        connectionString: pgCfg.connectionString,
        dimensions: pgDims,
        logger,
        schema: pgCfg.schema,
      });
      logger?.debug?.(
        `${TAG} Store created: backend=postgres, dimensions=${pgDims}, ` +
        `embedding=${pgEmbeddingService ? "enabled" : "disabled"}, ` +
        `bm25=${bm25Encoder ? "enabled" : "disabled"}`,
      );
      return {
        store,
        embedding: pgEmbeddingService as unknown as IEmbeddingService,
        bm25Encoder,
        storeSnapshot: { type: "postgres" as const, postgresConnection: pgCfg.connectionString },
      };
    }

    case "sqlite":
    default: {
      // ── Embedding service (only when enabled) ──
      let embeddingService: EmbeddingService | undefined;
      if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.apiKey) {
        embeddingService = createEmbeddingService({
          provider: config.embedding.provider,
          baseUrl: config.embedding.baseUrl,
          apiKey: config.embedding.apiKey,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          sendDimensions: config.embedding.sendDimensions,
          maxInputChars: config.embedding.maxInputChars,
        }, logger);
      }

      // dimensions from config (0 when provider="none" → vec0 deferred)
      const dims = config.embedding.dimensions;
      const dbPath = path.join(options.dataDir, "vectors.db");
      const store = new VectorStore(dbPath, dims, logger);

      logger?.debug?.(
        `${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
        `embedding=${embeddingService ? "enabled" : "disabled"}, ` +
        `bm25=${bm25Encoder ? "enabled" : "disabled"}`,
      );

      return {
        store,
        embedding: embeddingService as unknown as IEmbeddingService,
        bm25Encoder,
        storeSnapshot: {
          type: "sqlite",
          sqlitePath: path.relative(options.dataDir, dbPath),
        },
      };
    }
  }
}
