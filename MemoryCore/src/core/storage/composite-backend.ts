/**
 * CompositeStorageBackend — one file surface over two backends.
 *
 * Profile keys (`scene_blocks/<name>.md`, `persona.md`) are served by the
 * row-view backend (ProfileRowStorageBackend); every other key — records/,
 * conversations/, .metadata/, .backup/, skill resources, … — passes through
 * to the "others" file backend (local/COS/mongofs). This is what FILE_STORE_MODE=rowfs
 * mounts: L2/L3 live in the store as rows, while append-only JSONL and
 * pipeline bookkeeping stay on a real filesystem (design doc D8/A3).
 *
 * Routing rules:
 * - Point operations (get/put/append/exists/deleteObject) route by
 *   `isProfileKey(key)`, which defaults to the rowfs key convention
 *   (classifyPath) so the whole storage layer keeps ONE key convention (D12).
 * - Prefix operations (listObjects/deleteByPrefix) route by whether the
 *   prefix selects the profile key space. The empty/universal prefix routes
 *   to the others leg only: merging two backends' paginated listings would
 *   break the marker contract (D9.2 clause 9), and real callers always list
 *   a concrete directory.
 *
 * `type` reports "rowfs": the composite exists to mount the row-view file
 * mode, and consumers keying on `type` (the session materialization
 * short-circuit, diagnostics) must see the row semantics, not the
 * others leg's.
 */

import type { ProfileIsolation } from "../profile/profile-scope.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";
import { classifyPath } from "./profile-row-backend.js";
import {
  StoragePaths,
  type IStorageBackend,
  type ListObjectsOptions,
  type ListResult,
  type PutObjectOptions,
  type StorageLogger,
  type StorageObject,
} from "./types.js";

const TAG = "[storage][composite]";

/**
 * A backend whose profile view can be rebound to an isolation domain.
 * Implemented by ProfileRowStorageBackend (rebinds the row query) and
 * CompositeStorageBackend (rebinds its profile side, others leg untouched).
 */
export interface ProfileIsolationRebindable extends IStorageBackend {
  withProfileIsolation(isolation?: ProfileIsolation): IStorageBackend;
}

/** Narrow to {@link ProfileIsolationRebindable}. */
export function isProfileIsolationRebindable(backend: IStorageBackend): backend is ProfileIsolationRebindable {
  return typeof (backend as ProfileIsolationRebindable).withProfileIsolation === "function";
}

export interface CompositeStorageBackendOptions {
  /** Row-view backend serving the profile key space (scene_blocks/, persona.md). */
  profileBackend: IStorageBackend;
  /** Backend serving every other key (records/, conversations/, .metadata/, …). */
  others: IStorageBackend;
  /**
   * Point-key router. Defaults to the rowfs key convention (classifyPath),
   * keeping one key convention for the whole storage layer (D12).
   */
  isProfileKey?: (key: string) => boolean;
  logger?: StorageLogger;
}

export class CompositeStorageBackend implements IStorageBackend {
  readonly type = "rowfs" as const;

  private readonly profile: IStorageBackend;
  private readonly othersBackend: IStorageBackend;
  private readonly isProfileKey: (key: string) => boolean;
  private readonly logger?: StorageLogger;

  constructor(opts: CompositeStorageBackendOptions) {
    this.profile = opts.profileBackend;
    this.othersBackend = opts.others;
    this.isProfileKey = opts.isProfileKey ?? ((key) => classifyPath(key) !== null);
    this.logger = opts.logger;
  }

  /**
   * Rebind the profile side to an isolation domain; the others leg passes
   * through unchanged (non-profile keys carry no tenancy).
   *
   * Throws when the profile side cannot rebind: serving a scoped request
   * through an unbound (whole-set) row view would leak across tenants, so
   * this must surface loudly at wiring time rather than silently.
   */
  withProfileIsolation(isolation?: ProfileIsolation): CompositeStorageBackend {
    if (!isProfileIsolationRebindable(this.profile)) {
      throw new Error(
        `${TAG} withProfileIsolation: profile backend (type=${this.profile.type}) cannot bind isolation — ` +
          `refusing to serve a scoped request through an unbound row view`,
      );
    }
    return new CompositeStorageBackend({
      profileBackend: this.profile.withProfileIsolation(isolation),
      others: this.othersBackend,
      isProfileKey: this.isProfileKey,
      logger: this.logger,
    });
  }

  /**
   * 场景索引派生（P2-D2）：委托给 profile 行侧。`scene-index.ts` 的
   * readSceneIndex/syncSceneIndex 通过结构化探测发现本方法——rowfs 模式下
   * 索引从 L2 行实时投影，`.metadata/scene_index.json` 不读不写。
   */
  async deriveSceneIndex(): Promise<SceneIndexEntry[]> {
    const profile = this.profile as unknown as { deriveSceneIndex?: () => Promise<SceneIndexEntry[]> };
    if (typeof profile.deriveSceneIndex !== "function") {
      throw new Error(
        `${TAG} deriveSceneIndex: profile backend (type=${this.profile.type}) cannot derive scene index`,
      );
    }
    return profile.deriveSceneIndex();
  }

  // ── Point operations ─────────────────────────────────────

  async getObject(key: string): Promise<StorageObject | null> {
    return this.route(key).getObject(key);
  }

  async putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    return this.route(key).putObject(key, content, opts);
  }

  async appendObject(key: string, content: string | Buffer): Promise<void> {
    // On a profile key this rejects (a row is a whole document) — that is the
    // desired rowfs-mode behaviour; append-only JSONL lives on the others leg.
    return this.route(key).appendObject(key, content);
  }

  async exists(key: string): Promise<boolean> {
    return this.route(key).exists(key);
  }

  async deleteObject(key: string): Promise<void> {
    return this.route(key).deleteObject(key);
  }

  // ── Prefix operations ────────────────────────────────────

  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    return this.routePrefix(prefix).listObjects(prefix, opts);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    return this.routePrefix(prefix).deleteByPrefix(prefix);
  }

  // ── Routers ──────────────────────────────────────────────

  private route(key: string): IStorageBackend {
    const backend = this.isProfileKey(key) ? this.profile : this.othersBackend;
    this.logger?.debug?.(`${TAG} route ${backend.type}: ${key}`);
    return backend;
  }

  /**
   * A prefix selects the profile space when it reaches into `scene_blocks/`
   * or names `persona.md` — including partial spellings of those two (a list
   * of "scene_bl" must still see rows). Such a partial spelling can shadow
   * same-spelled others-leg keys; accepted, because real callers always list a
   * concrete directory. The empty prefix selects the others leg only.
   */
  private routePrefix(prefix: string): IStorageBackend {
    if (!prefix) return this.othersBackend;
    const dir = StoragePaths.sceneBlocksDir;
    const hitsProfile =
      prefix.startsWith(dir) || dir.startsWith(prefix) || StoragePaths.persona.startsWith(prefix);
    const backend = hitsProfile ? this.profile : this.othersBackend;
    this.logger?.debug?.(`${TAG} route ${backend.type}: prefix ${prefix}`);
    return backend;
  }
}
