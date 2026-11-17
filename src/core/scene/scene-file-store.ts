/**
 * Scene block persistence helper.
 *
 * Two safety properties matter when rewriting `scene_blocks/*.md`:
 *
 *  1. **Service mode is not isolated per session.** The L2 lock is scoped to
 *     `pipeline:{instanceId}:{sessionId}` while `scene_blocks/` is shared by
 *     every session of the instance, so a blind read-modify-write would
 *     overwrite a body another session just wrote. We therefore re-read the
 *     object and bail out unless it is byte-identical to what the caller
 *     parsed. Callers must treat `false` as "try again next round" — never as
 *     an error.
 *
 *  2. **Local writes must be atomic.** A crash in the middle of
 *     `fs.writeFile` would truncate a scene block, so writes go through a
 *     temp file plus `rename`.
 */

import type { Logger } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";

export interface SceneFileWriteOptions {
  /** Local data directory (ignored in service mode). */
  dataDir: string;
  /** StorageAdapter for COS/service mode; fs is used when absent. */
  storage?: StorageAdapter;
  logger?: Logger;
}

const TAG = "[memory-tdai] [scene-file]";

/**
 * Write `nextRaw` to `file` only if the current content still equals
 * `expectedRaw`.
 *
 * @returns true when the write happened, false when it was skipped (content
 *          changed underneath, file vanished) or failed. Never throws.
 */
export async function writeSceneFileIfUnchanged(
  file: string,
  expectedRaw: string,
  nextRaw: string,
  opts: SceneFileWriteOptions,
): Promise<boolean> {
  try {
    if (opts.storage) {
      const key = `${StoragePaths.sceneBlocksDir}${file}`;
      const current = await opts.storage.readFile(key);
      if (current !== expectedRaw) {
        opts.logger?.debug?.(`${TAG} write skipped (concurrent modification): ${file}`);
        return false;
      }
      await opts.storage.writeFile(key, nextRaw);
      return true;
    }

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const absPath = path.default.join(opts.dataDir, "scene_blocks", file);
    const current = await fs.default.readFile(absPath, "utf-8");
    if (current !== expectedRaw) {
      opts.logger?.debug?.(`${TAG} write skipped (concurrent modification): ${file}`);
      return false;
    }
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.default.writeFile(tmpPath, nextRaw, "utf-8");
    await fs.default.rename(tmpPath, absPath);
    return true;
  } catch (err) {
    opts.logger?.warn(
      `${TAG} write failed for ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
