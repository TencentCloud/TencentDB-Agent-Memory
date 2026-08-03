/**
 * Store init + manifest wiring for the pipeline-factory.
 *
 * Owns: `initDataDirectories`, `initStores`, `resetStores`, the once-async
 * store init cache, and the manifest first-write + config-drift detection.
 *
 * Side effects in `initDataDirectories` are preserved verbatim (mkdirSync
 * recursive on a fixed set of subdirs).
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import { createStoreBundle } from "../../core/store/factory.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import { buildStoreInfo, diffStoreBinding, readManifest, writeManifest, type Manifest } from "../manifest.js";
import type { PipelineLogger } from "./types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

/** Ensure all required data subdirectories exist under `pluginDataDir`. */
export function initDataDirectories(dataDir: string): void {
  const dirs = ["conversations", "records", "scene_blocks", ".metadata", ".backup"];
  for (const sub of dirs) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

export interface StoreInitResult {
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  /** Whether a background re-index is needed (embedding config changed). */
  needsReindex: boolean;
  reindexReason?: string;
}

/** Per-dataDir cache so concurrent callers share one init. */
const _storeInitCache = new Map<string, Promise<StoreInitResult>>();

/**
 * Initialize store backend and (optionally) EmbeddingService.
 * Once-async semantics per dataDir: first call creates + caches, subsequent
 * calls return the cached Promise. Call `resetStores()` on shutdown.
 */
export function initStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  if (!_storeInitCache.has(pluginDataDir)) {
    _storeInitCache.set(pluginDataDir, _doInitStores(cfg, pluginDataDir, logger));
  }
  return _storeInitCache.get(pluginDataDir)!;
}

/** Reset the cached store singleton(s). Call during `gateway_stop`. */
export function resetStores(pluginDataDir?: string): void {
  if (pluginDataDir) _storeInitCache.delete(pluginDataDir);
  else _storeInitCache.clear();
}

async function _doInitStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  let vectorStore: IMemoryStore | undefined;
  let embeddingService: EmbeddingService | undefined;
  let needsReindex = false;
  let reindexReason: string | undefined;

  try {
    const bundle = createStoreBundle(cfg, { dataDir: pluginDataDir, logger });
    vectorStore = bundle.store;
    embeddingService = bundle.embedding ?? undefined;

    const providerInfo = embeddingService?.getProviderInfo();
    const initResult = await vectorStore.init(providerInfo);

    if (vectorStore.isDegraded()) {
      logger.warn(`${TAG} Store is in degraded mode, falling back to keyword dedup`);
      vectorStore = undefined;
      embeddingService = undefined;
    } else {
      logger.debug?.(`${TAG} Store initialized: backend=${cfg.storeBackend}, provider=${cfg.embedding.provider}`);
      needsReindex = initResult.needsReindex;
      reindexReason = initResult.reason;

      // Manifest: first-write + config-drift detection
      try {
        const currentStoreInfo = buildStoreInfo(bundle.storeSnapshot);
        const existing = readManifest(pluginDataDir);
        if (!existing) {
          const manifest: Manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            store: currentStoreInfo,
            seed: null,
          };
          writeManifest(pluginDataDir, manifest);
          logger.debug?.(`${TAG} Manifest created: ${JSON.stringify(currentStoreInfo)}`);
        } else {
          const diffs = diffStoreBinding(existing.store, currentStoreInfo);
          if (diffs.length > 0) {
            logger.debug?.(
              `${TAG} Store config differs from initial binding recorded in manifest ` +
              `(${diffs.join("; ")}). This is expected if the storage backend was switched intentionally.`,
            );
          }
        }
      } catch (err) {
        logger.warn(`${TAG} Failed to read/write manifest (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(
      `${TAG} Store init failed; vector/FTS recall and dedup conflict detection will be unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    vectorStore = undefined;
    embeddingService = undefined;
  }

  return { vectorStore, embeddingService, needsReindex, reindexReason };
}
