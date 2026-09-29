/**
 * Store Factory — creates the appropriate storage backend and embedding service
 * based on plugin configuration.
 *
 * Supports:
 * - "sqlite" (default): local SQLite + sqlite-vec + FTS5
 * - "tcvdb": Tencent Cloud VectorDB (server-side embedding + hybridSearch)
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
          maxBatchSize: config.embedding.maxBatchSize,
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
