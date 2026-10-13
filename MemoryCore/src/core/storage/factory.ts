/**
 * Storage Backend Factory — creates the appropriate IStorageBackend
 * based on configuration.
 *
 * The local backend is bundled with core. The retired private COS backend is
 * rejected explicitly; no unavailable integration is dynamically loaded.
 */

import type { IStorageBackend, StorageBackendConfig, StorageLogger } from "./types.js";
import { LocalStorageBackend } from "./local-backend.js";

const TAG = "[storage][factory]";

/**
 * Create a storage backend instance based on configuration.
 *
 * Retains the asynchronous public API used by existing callers.
 *
 * @param config Backend configuration (type + backend-specific options)
 * @param logger Optional logger
 * @returns IStorageBackend instance
 */
export async function createStorageBackend(
  config: StorageBackendConfig,
  logger?: StorageLogger,
): Promise<IStorageBackend> {
  switch (config.type) {
    case "cos": {
      throw new Error(
        `${TAG} COS backend is not supported in this public build; use storage type=local.`,
      );
    }

    case "local":
    default: {
      const rootDir = config.localRootDir ?? "./data/storage";
      logger?.info(`${TAG} Creating local storage backend: rootDir=${rootDir}`);
      return new LocalStorageBackend({
        rootDir,
        logger,
      });
    }
  }
}

/**
 * Create a local storage backend for development.
 * Convenience helper for quick local setup.
 */
export function createLocalStorageBackend(
  rootDir: string,
  logger?: StorageLogger,
): IStorageBackend {
  return new LocalStorageBackend({ rootDir, logger });
}
