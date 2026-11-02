/**
 * ProfileRowStorageBackend (`rowfs`) — a file view over L2/L3 profile rows.
 *
 * Implements IStorageBackend on top of an IMemoryStore instead of a disk or a
 * bucket: `scene_blocks/<name>.md` and `persona.md` are served straight from
 * the store's profile rows, so the row *is* the file and no second copy exists.
 *
 * Design constraints (design doc D12) that this file must keep holding:
 *
 *  1. **One key convention only** — `scene_blocks/<name>.md` and `persona.md`,
 *     both taken from {@link StoragePaths}. `scenes/...` is not accepted, in
 *     any form; {@link classifyPath} returns null for it.
 *  2. **One path resolver only** — every key↔row translation goes through
 *     {@link classifyPath} / {@link rowToKey}. Do not add a second resolver.
 *  3. **Keys carry no scope.** A backend instance is bound to one isolation
 *     domain at construction, and that domain enters the *query*, never the
 *     path. Two instances therefore cannot disagree about where a file lives.
 *
 * Those three rules are the direct countermeasures to the `scenes/` vs
 * `scene_blocks/` split that survived for months in the COS path.
 */

import { createHash } from "node:crypto";

import {
  buildProfileIsolationScope,
  buildProfileStableId,
  profileRowInScope,
  profileScopeFilter,
  type ProfileIsolation,
} from "../profile/profile-scope.js";
import { deriveSceneIndexFromProfiles } from "../scene/scene-derive.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";
import { renderSceneNavigation, stripSceneNavigation, storageNavFooter } from "../scene/scene-navigation.js";
import type {
  ProfileFilter,
  ProfileRecord,
  ProfileRowCapableStore,
  ProfileSyncRecord,
} from "../store/types.js";
import { pageEntries } from "./list-page.js";
import {
  StoragePaths,
  type IStorageBackend,
  type ListEntry,
  type ListObjectsOptions,
  type ListResult,
  type PutObjectOptions,
  type StorageLogger,
  type StorageObject,
} from "./types.js";

const TAG = "[storage][rowfs]";

/** A storage key resolved to the profile row that backs it. */
export interface ProfileRowPath {
  type: "l2" | "l3";
  /** The row's `filename` column — relative to `scene_blocks/` for L2. */
  filename: string;
}

/**
 * The single key↔row resolver (D12 ②).
 *
 * @param key Storage key as the model/tools see it, e.g. `scene_blocks/work/q1.md`.
 * @returns The backing row coordinates, or `null` when the key is outside the
 *          row-view key space — including the legacy `scenes/` spelling, which
 *          is rejected on purpose rather than aliased.
 */
export function classifyPath(key: string): ProfileRowPath | null {
  if (!key || key.includes("\0") || key.startsWith("/")) return null;
  if (key === StoragePaths.persona) return { type: "l3", filename: StoragePaths.persona };
  if (!key.startsWith(StoragePaths.sceneBlocksDir)) return null;

  const filename = key.slice(StoragePaths.sceneBlocksDir.length);
  if (!filename || !filename.endsWith(".md")) return null;
  if (filename.split("/").includes("..")) return null;
  return { type: "l2", filename };
}

/** Inverse of {@link classifyPath}: the key a row is served under. */
export function rowToKey(row: Pick<ProfileRecord, "type" | "filename">): string {
  return row.type === "l3"
    ? row.filename
    : `${StoragePaths.sceneBlocksDir}${row.filename}`;
}

export interface ProfileRowStorageBackendOptions {
  /** Data plane holding the profile rows. Must satisfy IProfileRowStore. */
  store: ProfileRowCapableStore;
  /** Tenancy this instance is bound to. Omitted = the store's whole profile set. */
  isolation?: ProfileIsolation;
  /**
   * Serve `persona.md` with a scene navigation section derived from the L2
   * rows, instead of whatever navigation happens to be stored in the row.
   *
   * Present = enabled. It carries `readTool` because the tool the model should
   * call belongs to the mounted surface (`tdai_read_file`, a bridge endpoint,
   * …), which the backend cannot know. Absent = the row is returned verbatim.
   */
  navigation?: { readTool: string };
  logger?: StorageLogger;
}

export class ProfileRowStorageBackend implements IStorageBackend {
  readonly type = "rowfs" as const;

  private readonly store: ProfileRowCapableStore;
  private readonly isolation?: ProfileIsolation;
  private readonly scope: string;
  private readonly navigation?: { readTool: string };
  private readonly logger?: StorageLogger;

  constructor(opts: ProfileRowStorageBackendOptions) {
    this.store = opts.store;
    this.isolation = opts.isolation;
    this.scope = buildProfileIsolationScope(opts.isolation);
    this.navigation = opts.navigation;
    this.logger = opts.logger;
  }

  /**
   * Rebind to an isolation domain, sharing store/navigation/logger.
   *
   * This is how a request-scoped reader gets its tenant view: the isolation
   * enters the row *query*, never the key — wrapping the backend in a
   * `profiles/{scope}/` key prefix instead would make every key unclassifiable
   * (D12 ③). Cheap: no I/O, just a new scope string.
   */
  withProfileIsolation(isolation?: ProfileIsolation): ProfileRowStorageBackend {
    return new ProfileRowStorageBackend({
      store: this.store,
      isolation,
      navigation: this.navigation,
      logger: this.logger,
    });
  }

  /**
   * 场景索引派生（P2-D2）：本 scope L2 行的实时投影，替代
   * `.metadata/scene_index.json`。`scene-index.ts` 的
   * readSceneIndex/syncSceneIndex 通过结构化探测发现本方法。
   */
  async deriveSceneIndex(): Promise<SceneIndexEntry[]> {
    return deriveSceneIndexFromProfiles(this.store, this.isolation);
  }

  // ── Reads ────────────────────────────────────────────────

  async getObject(key: string): Promise<StorageObject | null> {
    const row = await this.rowFor(key);
    if (!row) return null;

    const content = row.type === "l3" && this.navigation
      ? await this.personaWithNavigation(row.content)
      : row.content;

    return {
      key,
      content: Buffer.from(content, "utf-8"),
      contentType: "text/markdown",
      lastModified: new Date(row.updatedAtMs),
      size: Buffer.byteLength(content, "utf-8"),
    };
  }

  /**
   * Persona body plus navigation derived from the current L2 rows.
   *
   * `pathFor` goes through {@link rowToKey}, the same resolver
   * {@link getObject} reads with, so every path this emits is a path this
   * instance can serve — the invariant the `scenes/` bug violated.
   */
  private async personaWithNavigation(stored: string): Promise<string> {
    const body = stripSceneNavigation(stored);
    const entries = await deriveSceneIndexFromProfiles(this.store, this.isolation);
    const nav = renderSceneNavigation(entries, {
      pathFor: (e) => rowToKey({ type: "l2", filename: e.filename }),
      readTool: this.navigation!.readTool,
      footer: storageNavFooter(this.navigation!.readTool),
    });
    return nav ? `${body}\n\n${nav}` : body;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.rowFor(key)) !== null;
  }

  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    const recursive = opts?.recursive ?? false;
    const matches = await this.keysForPrefix(prefix);

    if (recursive) {
      return pageEntries(matches.map(({ key, row }) => this.fileEntry(key, row)), opts);
    }

    // D9.2-2: collapse anything below the next "/" into one directory entry.
    const entries: ListEntry[] = [];
    const seenDirs = new Set<string>();
    for (const { key, row } of matches) {
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        entries.push(this.fileEntry(key, row));
        continue;
      }
      const dirKey = prefix + rest.slice(0, slash + 1);
      if (seenDirs.has(dirKey)) continue;
      seenDirs.add(dirKey);
      entries.push({
        key: dirKey,
        size: 0,
        // D9.2-6: rowfs has no real directories, so there is no meaningful
        // mtime — a fixed epoch keeps repeated calls identical.
        lastModified: new Date(0),
        isDirectory: true,
      });
    }
    return pageEntries(entries, opts);
  }

  // ── Writes ───────────────────────────────────────────────

  async putObject(key: string, content: string | Buffer, _opts?: PutObjectOptions): Promise<void> {
    const path = this.requirePath(key, "putObject");
    const raw = typeof content === "string" ? content : content.toString("utf-8");
    // Navigation is derived on read, so persisting it would let a
    // read-modify-write cycle bake a stale copy into the row.
    const text = path.type === "l3" && this.navigation ? stripSceneNavigation(raw) : raw;
    const id = buildProfileStableId(this.scope, path.type, path.filename);
    const [existing] = await this.store.queryProfilesByIds([id]);
    const now = Date.now();

    const record: ProfileSyncRecord = {
      id,
      type: path.type,
      filename: path.filename,
      content: text,
      contentMd5: createHash("md5").update(text).digest("hex"),
      teamId: this.isolation?.teamId,
      agentId: this.isolation?.agentId,
      userId: this.isolation?.userId,
      sessionId: undefined,
      version: (existing?.version ?? 0) + 1,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      // Optimistic lock against the version we just read, so a concurrent
      // writer loses loudly instead of silently clobbering.
      ...(existing ? { baselineVersion: existing.version } : {}),
    };

    await this.store.syncProfiles([record]);
    this.logger?.debug?.(`${TAG} putObject: ${key} (v${record.version})`);
  }

  /**
   * Not supported: a profile row is a whole-document value, so there is no
   * position to append at. Callers that need append-only keys (L0/L1 JSONL)
   * must use a local or COS backend for those keys.
   */
  async appendObject(key: string, _content: string | Buffer): Promise<void> {
    throw new Error(
      `${TAG} appendObject is not supported: profile rows are whole documents, not append-only objects (key="${key}"). ` +
        `Read-modify-write with getObject + putObject, or mount a local/cos backend for append-only paths such as "${StoragePaths.recordsDir}".`,
    );
  }

  async deleteObject(key: string): Promise<void> {
    const path = classifyPath(key);
    if (!path) return; // idempotent: nothing outside the key space can exist
    await this.store.deleteProfiles([buildProfileStableId(this.scope, path.type, path.filename)]);
    this.logger?.debug?.(`${TAG} deleteObject: ${key}`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const matches = await this.keysForPrefix(prefix);
    if (matches.length === 0) return 0;
    await this.store.deleteProfiles(matches.map(({ row }) => row.id));
    this.logger?.debug?.(`${TAG} deleteByPrefix: ${prefix} (${matches.length} rows)`);
    return matches.length;
  }

  // ── Private helpers ──────────────────────────────────────

  private requirePath(key: string, op: string): ProfileRowPath {
    const path = classifyPath(key);
    if (!path) {
      throw new Error(
        `${TAG} ${op}: key "${key}" is outside the row-view key space. ` +
          `Only "${StoragePaths.sceneBlocksDir}<name>.md" and "${StoragePaths.persona}" are served.`,
      );
    }
    return path;
  }

  private async rowFor(key: string): Promise<ProfileRecord | null> {
    const path = classifyPath(key);
    if (!path) return null;
    const id = buildProfileStableId(this.scope, path.type, path.filename);
    const [row] = await this.store.queryProfilesByIds([id]);
    if (!row) return null;
    // The scope string collapses (team, user), so an id can be reached from an
    // isolation context whose rows this instance must not serve. Re-check the
    // row's own columns, or lookup would return a file that listing denies.
    if (!profileRowInScope(row, this.isolation)) {
      this.logger?.warn?.(`${TAG} rowFor: id ${id} resolved outside scope "${this.scope}" — treating "${key}" as absent`);
      return null;
    }
    return row;
  }

  /**
   * Scope conditions this instance is bound to (D12 ③ — never a path prefix).
   *
   * Delegates to {@link profileScopeFilter} rather than rebuilding the
   * conditions: the same function must serve every row-backed reader, or
   * listing and lookup drift apart the way they did before.
   */
  private scopeFilter(extra?: Partial<ProfileFilter>): ProfileFilter {
    return profileScopeFilter(this.isolation, extra);
  }

  /**
   * Rows whose key starts with `prefix`, with the prefix pushed into the query
   * where the layout allows it (D9.2-1: a string prefix, not a directory).
   */
  private async keysForPrefix(prefix: string): Promise<{ key: string; row: ProfileRecord }[]> {
    const dir = StoragePaths.sceneBlocksDir;
    const rows: ProfileRecord[] = [];

    if (prefix.startsWith(dir)) {
      // Fully inside scene_blocks/ → the remainder is a filename prefix.
      rows.push(...await this.store.queryProfiles(
        this.scopeFilter({ type: "l2", pathPrefix: prefix.slice(dir.length) }),
      ));
    } else {
      // The prefix stops before/at "scene_blocks/" (e.g. "" or "scene_bl"), so
      // it may still select L2 rows, L3, or both.
      if (dir.startsWith(prefix)) {
        rows.push(...await this.store.queryProfiles(this.scopeFilter({ type: "l2" })));
      }
      if (StoragePaths.persona.startsWith(prefix)) {
        rows.push(...await this.store.queryProfiles(this.scopeFilter({ type: "l3" })));
      }
    }

    return rows
      .map((row) => ({ key: rowToKey(row), row }))
      .filter(({ key }) => key.startsWith(prefix));
  }

  private fileEntry(key: string, row: ProfileRecord): ListEntry {
    return {
      key,
      size: Buffer.byteLength(row.content, "utf-8"),
      lastModified: new Date(row.updatedAtMs),
      isDirectory: false,
    };
  }
}
