/**
 * GitStorageBackend — Git-backed implementation of IStorageBackend.
 *
 * See docs/rfc/git-storage-backend.md and
 * docs/design/git-storage-backend-implementation-plan.md for the full design
 * rationale. Summary: one independent `git clone --single-branch` per memory
 * space, delegating ordinary file I/O to an inner LocalStorageBackend and
 * layering a WAL + batched commit/push + replay-on-rejection on top of the
 * mutating methods only. Experimental — single-writer-per-space pilot scope.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  IStorageBackend,
  StorageObject,
  PutObjectOptions,
  ListObjectsOptions,
  ListResult,
  StorageLogger,
  IGitCredentialProvider,
} from "./types.js";
import type { IStateBackend } from "../state/types.js";
import { LocalStorageBackend } from "./local-backend.js";
import { resolveSafeRelativePath } from "./path-safety.js";
import { SerialQueue } from "../../utils/serial-queue.js";
import {
  buildGitAuth,
  gitAdd,
  gitCheckoutDiscard,
  gitCheckoutOrphan,
  gitCheckRefFormat,
  gitClone,
  gitCommit,
  gitFetch,
  gitInit,
  gitLogOpIds,
  gitLsRemoteHasBranch,
  gitMergeBase,
  gitPush,
  gitRemoteAdd,
  gitResetHard,
  gitStatusPorcelain,
  gitStatusPorcelainForPath,
  type GitAuth,
} from "./git-cli.js";

const TAG = "[storage][git]";
const MAX_SLUG_CHARS = 40;
const MAX_BRANCH_NAME_CHARS = 200;

// ============================
// Branch naming
// ============================

function sanitizeSlug(input: string): string {
  let slug = "";
  for (const ch of input.toLowerCase()) {
    slug += /[a-z0-9_-]/.test(ch) ? ch : "-";
  }
  slug = slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "empty";
  return slug.length > MAX_SLUG_CHARS ? slug.slice(0, MAX_SLUG_CHARS) : slug;
}

export interface BranchNameSeed {
  tenantId: string;
  instanceId: string;
}

/**
 * memory/{tenantSlug}/{instanceSlug}-{hash32hex}. The hash covers a
 * length-prefixed encoding of the raw (unsanitized) seed so two different
 * (tenantId, instanceId) pairs can never sanitize+concatenate to the same
 * hash input (e.g. ("ab","c") vs ("a","bc")); 32 hex chars = 128 bit, wide
 * enough that collisions aren't a realistic concern at pilot scale.
 */
export function buildBranchName(seed: BranchNameSeed): string {
  const tenantSlug = sanitizeSlug(seed.tenantId);
  const instanceSlug = sanitizeSlug(seed.instanceId);
  const encoded = `${seed.tenantId.length}:${seed.tenantId}${seed.instanceId.length}:${seed.instanceId}`;
  const hash = createHash("sha256").update(encoded, "utf-8").digest("hex").slice(0, 32);
  const branchName = `memory/${tenantSlug}/${instanceSlug}-${hash}`;
  if (branchName.length > MAX_BRANCH_NAME_CHARS) {
    throw new Error(`${TAG} branch name exceeds ${MAX_BRANCH_NAME_CHARS} chars: ${branchName.length}`);
  }
  return branchName;
}

// ============================
// WAL (write-ahead log)
// ============================

interface WalEntry {
  opId: string;
  kind: "put" | "append" | "delete" | "deleteByPrefix";
  key: string;
  /** base64 content, for put/append replay. */
  contentBase64?: string;
  opts?: PutObjectOptions;
  ts: number;
}

async function loadWalFile(path: string): Promise<WalEntry[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  const entries: WalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as WalEntry);
    } catch {
      // skip a corrupt/truncated line (e.g. process killed mid-write)
    }
  }
  return entries;
}

async function appendWalLine(path: string, entry: WalEntry): Promise<void> {
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

async function rewriteWalFile(path: string, entries: WalEntry[]): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(tmpPath, entries.length ? `${body}\n` : "");
  await rename(tmpPath, path);
}

function toBase64(content: string | Buffer): string {
  return (typeof content === "string" ? Buffer.from(content, "utf-8") : content).toString("base64");
}

function fromBase64(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract the path from one `git status --porcelain` line ("XY path", quoted, or a "orig -> new" rename). */
function parsePorcelainPath(line: string): string {
  let rest = line.slice(3);
  const arrowIdx = rest.indexOf(" -> ");
  if (arrowIdx >= 0) rest = rest.slice(arrowIdx + 4);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  // git always reports paths with forward slashes regardless of OS.
  return rest;
}

/**
 * Drop status lines that are expected, not "unexplained" dirt: the
 * never-staged `.meta.json` sidecar (local-only by design — see path-safety
 * discussion in the design doc) and paths covered by a currently-pending WAL
 * op (exact match for put/append/delete, prefix match for deleteByPrefix).
 */
function filterUnexplainedDirt(
  statusOutput: string,
  explainedExactPaths: Set<string>,
  explainedPrefixes: string[],
): string {
  return statusOutput
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const path = parsePorcelainPath(line);
      if (path.endsWith(".meta.json")) return false;
      if (explainedExactPaths.has(path)) return false;
      if (explainedPrefixes.some((prefix) => path.startsWith(prefix))) return false;
      return true;
    })
    .join("\n");
}

// ============================
// GitStorageBackend
// ============================

export type GitSyncStatus = "clean" | "dirty-local" | "pushing" | "replaying" | "push-failed";

export interface GitSyncSummary {
  status: GitSyncStatus;
  pendingCount: number;
  lastPushedAt: number | null;
  /** WAL timestamp of the oldest still-pending op, or null if nothing is pending. Distinct from lastPushedAt — a space that has never pushed successfully still has a real, computable pending age via this field. */
  oldestPendingOpTs: number | null;
}

export interface GitStorageBackendOptions {
  /** Local clone root; one subdirectory under it for this space's clone + state. */
  localRootDir: string;
  remoteUrl: string;
  credentialProvider: IGitCredentialProvider;
  branchNameSeed: BranchNameSeed;
  /** Injected, never imported from src/core/state/* directly (CI red-line). */
  stateBackend: IStateBackend;
  /** Debounce window for batching writes into one commit, ms. 0 = commit per call. Default 2000. */
  batchWindowMs?: number;
  /** Hard cap on debounce delay under sustained load, ms. Default 10000. */
  maxBatchDelayMs?: number;
  /** Distributed lock TTL, ms. Default 30000. */
  lockTtlMs?: number;
  /** Max push-rejected replay attempts. Default 5. */
  maxPushRetries?: number;
  /** Default "manual". */
  recoveryMode?: "manual" | "auto-wal-only";
  logger?: StorageLogger;
}

export class GitStorageBackend implements IStorageBackend {
  readonly type = "git" as const;

  private readonly branchName: string;
  private readonly cloneDir: string;
  private readonly stateDir: string;
  private readonly walPath: string;
  private readonly syncStatePath: string;
  private readonly ownerId: string;
  private readonly lockKey: string;
  private readonly queue: SerialQueue;
  private readonly logger?: StorageLogger;
  private readonly batchWindowMs: number;
  private readonly maxBatchDelayMs: number;
  private readonly lockTtlMs: number;
  private readonly maxPushRetries: number;
  private readonly recoveryMode: "manual" | "auto-wal-only";

  private inner!: LocalStorageBackend;
  private initPromise?: Promise<void>;
  private recoveryBlocked = false;

  private pendingOps: WalEntry[] = [];
  private uncommittedOpIds = new Set<string>();
  private syncStatus: GitSyncStatus = "clean";
  private lastPushedAt: number | null = null;

  private flushTimer?: ReturnType<typeof setTimeout>;
  private lockRenewTimer?: ReturnType<typeof setInterval>;
  private lockLost = false;

  constructor(private readonly opts: GitStorageBackendOptions) {
    this.logger = opts.logger;
    this.branchName = buildBranchName(opts.branchNameSeed);
    const branchDirName = this.branchName.replace(/\//g, "_");
    this.cloneDir = join(opts.localRootDir, "clones", branchDirName);
    this.stateDir = join(opts.localRootDir, "state", branchDirName);
    this.walPath = join(this.stateDir, "pending-ops.jsonl");
    this.syncStatePath = join(this.stateDir, "sync-state.json");
    this.ownerId = `git-storage-${randomUUID()}`;
    this.lockKey = `git-storage:${this.branchName}`;
    this.queue = new SerialQueue(`git-storage:${branchDirName}`);
    this.batchWindowMs = opts.batchWindowMs ?? 2000;
    this.maxBatchDelayMs = opts.maxBatchDelayMs ?? 10000;
    this.lockTtlMs = opts.lockTtlMs ?? 30000;
    this.maxPushRetries = opts.maxPushRetries ?? 5;
    this.recoveryMode = opts.recoveryMode ?? "manual";
  }

  // ── IStorageBackend ──────────────────────────────────────────

  async putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    await this.ensureInitialized();
    const relPath = this.safeRelPath(key);
    await this.queue.add(() =>
      this.applyAndStage(
        { opId: randomUUID(), kind: "put", key, contentBase64: toBase64(content), opts, ts: Date.now() },
        relPath,
        () => this.inner.putObject(key, content, opts),
      ),
    );
  }

  async appendObject(key: string, content: string | Buffer): Promise<void> {
    await this.ensureInitialized();
    const relPath = this.safeRelPath(key);
    await this.queue.add(() =>
      this.applyAndStage(
        { opId: randomUUID(), kind: "append", key, contentBase64: toBase64(content), ts: Date.now() },
        relPath,
        () => this.inner.appendObject(key, content),
      ),
    );
  }

  async getObject(key: string): Promise<StorageObject | null> {
    await this.ensureInitialized();
    this.safeRelPath(key);
    return this.inner.getObject(key);
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureInitialized();
    this.safeRelPath(key);
    return this.inner.exists(key);
  }

  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    await this.ensureInitialized();
    this.safeRelPath(prefix);
    return this.inner.listObjects(prefix, opts);
  }

  async deleteObject(key: string): Promise<void> {
    await this.ensureInitialized();
    const relPath = this.safeRelPath(key);
    await this.queue.add(async () => {
      if (this.recoveryBlocked) {
        throw new Error(`${TAG} writes blocked for ${this.branchName}: recovery required (recoveryMode=manual)`);
      }
      // `git add -- <path>` fails with "pathspec did not match any files" for
      // a path git has never tracked — unlike a path it tracked and that was
      // since removed, where `git add` correctly stages the deletion. This
      // existence check is read-only (no write-ahead concern) — only a
      // genuine deletion needs a WAL entry; deleteObject is idempotent
      // (IStorageBackend contract), so a no-op delete needs no record.
      const existed = await this.inner.exists(key);
      if (!existed) return;
      const entry: WalEntry = { opId: randomUUID(), kind: "delete", key, ts: Date.now() };
      await this.recordIntent(entry);
      await this.inner.deleteObject(key);
      await gitAdd(this.cloneDir, relPath);
      await this.writeSyncState("dirty-local");
      this.scheduleFlush();
    });
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    await this.ensureInitialized();
    const relPath = this.safeRelPath(prefix);
    return this.queue.add(async () => {
      if (this.recoveryBlocked) {
        throw new Error(`${TAG} writes blocked for ${this.branchName}: recovery required (recoveryMode=manual)`);
      }
      // Unlike deleteObject, whether this will be a no-op is only known
      // after actually calling deleteByPrefix — so record intent first
      // (write-ahead) and retract it if it turns out nothing existed.
      const entry: WalEntry = { opId: randomUUID(), kind: "deleteByPrefix", key: prefix, ts: Date.now() };
      await this.recordIntent(entry);
      const count = await this.inner.deleteByPrefix(prefix);
      if (count > 0) {
        await gitAdd(this.cloneDir, relPath);
        await this.writeSyncState("dirty-local");
        this.scheduleFlush();
      } else {
        await this.retractIntent(entry.opId);
      }
      return count;
    });
  }

  /**
   * Force an immediate flush and wait for it to complete (or throw).
   * NOT part of IStorageBackend — a Git-specific durability barrier for
   * callers that need a synchronous "confirmed pushed" signal once, after a
   * whole workflow (e.g. several deleteByPrefix calls), rather than after
   * every individual mutation.
   */
  async flush(): Promise<void> {
    await this.ensureInitialized();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.queue.add(() => this.flushLocked());
  }

  /** Sync-state snapshot for health-check exposure. Reads in-memory state only, no I/O. */
  getSyncSummary(): GitSyncSummary {
    const oldestPendingOpTs = this.pendingOps.length > 0 ? Math.min(...this.pendingOps.map((op) => op.ts)) : null;
    return {
      status: this.syncStatus,
      pendingCount: this.pendingOps.length,
      lastPushedAt: this.lastPushedAt,
      oldestPendingOpTs,
    };
  }

  /** Clear any live timers. Call when this instance is being discarded (e.g. cache eviction). */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.stopLockRenewal();
  }

  // ── Key validation ──────────────────────────────────────────

  /**
   * Validates the key (same traversal guard as LocalStorageBackend) and
   * additionally rejects any key resolving into `.git/` — the clone
   * directory's control files are reachable through ordinary keys unless
   * explicitly blocked, since delegation to the inner LocalStorageBackend is
   * a plain forward, not a sandboxed view.
   */
  private safeRelPath(key: string): string {
    const relPath = resolveSafeRelativePath(this.cloneDir, key);
    const firstSegment = relPath.split(sep)[0];
    if (firstSegment === ".git") {
      throw new Error(`${TAG} storage key resolves into git control directory: ${key}`);
    }
    return relPath;
  }

  // ── Initialization & recovery ───────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = undefined; // allow retry on next call
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(dirname(this.cloneDir), { recursive: true });
    if (!existsSync(join(this.cloneDir, ".git"))) {
      await this.cloneOrInitSpace();
    }
    this.inner = new LocalStorageBackend({ rootDir: this.cloneDir, logger: this.logger });
    await this.loadPersistedState();
    await this.recoverIfNeeded();
  }

  private async auth(): Promise<GitAuth> {
    const credential = await this.opts.credentialProvider.getGitCredential();
    return buildGitAuth(credential);
  }

  /**
   * Builds the clone into a staging directory and only renames it into place
   * (`this.cloneDir`) once every step succeeds. `doInitialize()` treats
   * "`.git` exists at cloneDir" as "fully initialized" — building in place
   * would let a step that fails partway (e.g. checkout-orphan succeeds but
   * the initial commit fails) leave a `.git` behind with no remote or wrong
   * branch; every later `ensureInitialized()` call would then see `.git`,
   * skip this method entirely, and proceed against a broken repo forever.
   */
  private async cloneOrInitSpace(): Promise<void> {
    await gitCheckRefFormat(this.branchName).then((ok) => {
      if (!ok) throw new Error(`${TAG} generated branch name fails check-ref-format: ${this.branchName}`);
    });
    const auth = await this.auth();
    const remoteHasBranch = await gitLsRemoteHasBranch(this.opts.remoteUrl, this.branchName, auth);
    const stagingDir = `${this.cloneDir}.init-${process.pid}-${Date.now()}`;
    try {
      if (remoteHasBranch) {
        this.logger?.info(`${TAG} cloning existing space ${this.branchName}`);
        await gitClone(this.opts.remoteUrl, stagingDir, this.branchName, auth);
      } else {
        this.logger?.info(`${TAG} initializing new space ${this.branchName}`);
        await mkdir(stagingDir, { recursive: true });
        await gitInit(stagingDir);
        await gitRemoteAdd(stagingDir, "origin", this.opts.remoteUrl, this.branchName);
        await gitCheckoutOrphan(stagingDir, this.branchName);
        await gitCommit(stagingDir, "git-storage: initialize space", { allowEmpty: true });
      }
      await rename(stagingDir, this.cloneDir);
    } catch (err) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  private async loadPersistedState(): Promise<void> {
    this.pendingOps = await loadWalFile(this.walPath);
    try {
      const raw = await readFile(this.syncStatePath, "utf-8");
      const parsed = JSON.parse(raw) as { lastPushedAt: number | null };
      this.lastPushedAt = parsed.lastPushedAt ?? null;
    } catch {
      this.lastPushedAt = null;
    }
  }

  private async recoverIfNeeded(): Promise<void> {
    const locallyCommittedOpIds = await gitLogOpIds(this.cloneDir, "-500");
    this.uncommittedOpIds = new Set(
      this.pendingOps.filter((e) => !locallyCommittedOpIds.has(e.opId)).map((e) => e.opId),
    );

    // Snapshot status BEFORE reapplying anything below, so the
    // unexplained-dirt judgment reflects only pre-existing, genuinely
    // unaccounted-for changes — not the staging we're about to do ourselves.
    // `.meta.json` sidecars are never staged by design (local-only metadata,
    // see design doc) and would otherwise show up as permanent "unexplained"
    // dirt on every restart after any putObject call that used
    // contentType/metadata, incorrectly tripping recoveryBlocked.
    const rawStatus = await gitStatusPorcelain(this.cloneDir);
    const explainedExactPaths = new Set<string>();
    const explainedPrefixes: string[] = [];
    for (const op of this.pendingOps) {
      if (!this.uncommittedOpIds.has(op.opId)) continue;
      const relPath = resolveSafeRelativePath(this.cloneDir, op.key).split(sep).join("/");
      if (op.kind === "deleteByPrefix") explainedPrefixes.push(relPath);
      else explainedExactPaths.add(relPath);
    }
    const unexplainedDirt = filterUnexplainedDirt(rawStatus, explainedExactPaths, explainedPrefixes);
    const hasUnexplainedDirt = unexplainedDirt.trim().length > 0;

    if (hasUnexplainedDirt) {
      if (this.recoveryMode === "auto-wal-only") {
        this.logger?.warn(`${TAG} discarding unexplained worktree dirt (recoveryMode=auto-wal-only): ${this.branchName}`);
        await gitCheckoutDiscard(this.cloneDir);
      } else {
        this.recoveryBlocked = true;
        this.logger?.error(
          `${TAG} unexplained worktree dirt for ${this.branchName}; refusing to auto-flush ` +
            `(recoveryMode=manual). Reads still work; writes will throw until resolved manually.`,
        );
        return;
      }
    }

    // A crash can land between a pending op's WAL-append and its apply()/
    // gitAdd() — per-path status is the ground truth for whether apply()
    // already ran: reapply (exactly once) only when nothing shows for that
    // path yet, otherwise just ensure it's staged. Reapplying an "append"
    // that already landed would double its content.
    for (const op of this.pendingOps) {
      if (!this.uncommittedOpIds.has(op.opId)) continue;
      const relPath = resolveSafeRelativePath(this.cloneDir, op.key);
      const pathStatus = await gitStatusPorcelainForPath(this.cloneDir, relPath);
      if (pathStatus.trim().length === 0) {
        await this.reapplyOp(op);
      } else {
        await gitAdd(this.cloneDir, relPath).catch(() => {});
      }
    }

    if (this.pendingOps.length > 0 || rawStatus.trim().length > 0) {
      await this.writeSyncState("dirty-local");
      this.scheduleFlush();
    }
  }

  // ── Write path ───────────────────────────────────────────────

  /**
   * Write-ahead: record intent in the WAL and in-memory pendingOps BEFORE
   * mutating the worktree, so a crash between them leaves a durable record
   * that recovery can reapply exactly once (see recoverIfNeeded's per-path
   * status check). Writing the WAL entry after apply() — the original
   * ordering — left a window where the mutation could happen with no record
   * of it at all, undetectable and unrecoverable on restart.
   */
  private async applyAndStage(entry: WalEntry, relPath: string, apply: () => Promise<void>): Promise<void> {
    if (this.recoveryBlocked) {
      throw new Error(`${TAG} writes blocked for ${this.branchName}: recovery required (recoveryMode=manual)`);
    }
    await this.recordIntent(entry);
    await apply();
    await gitAdd(this.cloneDir, relPath);
    await this.writeSyncState("dirty-local");
    this.scheduleFlush();
  }

  private async recordIntent(entry: WalEntry): Promise<void> {
    await appendWalLine(this.walPath, entry);
    this.pendingOps.push(entry);
    this.uncommittedOpIds.add(entry.opId);
  }

  private async retractIntent(opId: string): Promise<void> {
    this.pendingOps = this.pendingOps.filter((e) => e.opId !== opId);
    this.uncommittedOpIds.delete(opId);
    await rewriteWalFile(this.walPath, this.pendingOps);
  }

  private scheduleFlush(): void {
    if (this.recoveryBlocked) return;
    const runFlush = () => {
      this.queue.add(() => this.flushLocked()).catch((err) => {
        this.logger?.error(`${TAG} flush failed for ${this.branchName}: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    if (this.batchWindowMs <= 0) {
      runFlush();
      return;
    }
    if (this.flushTimer) return;
    const delay = Math.min(this.batchWindowMs, this.maxBatchDelayMs);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      runFlush();
    }, delay);
  }

  // ── Flush: lock → commit → push (with replay on rejection) ────

  private async flushLocked(): Promise<void> {
    if (this.recoveryBlocked) return;
    if (this.uncommittedOpIds.size === 0 && this.pendingOps.length === 0) return;

    const acquired = await this.opts.stateBackend.acquireLock(this.lockKey, this.ownerId, this.lockTtlMs);
    if (!acquired) {
      this.logger?.warn(`${TAG} lock busy for ${this.branchName}, retrying later`);
      this.scheduleFlush();
      return;
    }

    this.lockLost = false;

    try {
      // Lock renewal and the "pushing" state write both happen inside the
      // try so a failure in either (e.g. sync-state rename fails) still
      // reaches finally and releases the lock/timer instead of leaking them
      // for up to lockTtlMs (or, since renewal would otherwise keep
      // succeeding, effectively indefinitely).
      this.startLockRenewal();
      await this.writeSyncState("pushing");
      await this.commitUncommittedOps();
      await this.pushWithReplay();
      await this.writeSyncState("clean");
    } catch (err) {
      // WAL and any local commits are left intact either way — nothing is
      // discarded, so a later flush (triggered by the next write, or an
      // explicit flush() call) can pick up where this attempt left off.
      await this.writeSyncState(this.lockLost ? "dirty-local" : "push-failed");
      this.logger?.error(
        `${TAG} flush ${this.lockLost ? "aborted (lock lost)" : "failed"} for ${this.branchName}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      this.stopLockRenewal();
      await this.opts.stateBackend.releaseLock(this.lockKey, this.ownerId).catch(() => {});
    }
  }

  private startLockRenewal(): void {
    const interval = Math.max(1000, Math.floor(this.lockTtlMs / 2));
    this.lockRenewTimer = setInterval(() => {
      this.opts.stateBackend
        .renewLock(this.lockKey, this.ownerId, this.lockTtlMs)
        .then((renewed) => {
          if (!renewed) {
            this.lockLost = true;
            this.logger?.error(`${TAG} lock renewal failed for ${this.branchName}; aborting in-flight flush`);
          }
        })
        .catch(() => {
          this.lockLost = true;
        });
    }, interval);
  }

  private stopLockRenewal(): void {
    if (this.lockRenewTimer) {
      clearInterval(this.lockRenewTimer);
      this.lockRenewTimer = undefined;
    }
  }

  private assertLockHeld(): void {
    if (this.lockLost) {
      throw new Error(`${TAG} lock lost mid-flush for ${this.branchName}`);
    }
  }

  private async commitUncommittedOps(): Promise<void> {
    this.assertLockHeld();
    if (this.uncommittedOpIds.size === 0) return;
    const opIds = [...this.uncommittedOpIds];
    const message = `git-storage: batch commit\n\nOps: ${opIds.join(" ")}`;
    const committed = await gitCommit(this.cloneDir, message);
    if (committed) {
      this.uncommittedOpIds.clear();
    }
  }

  private async pushWithReplay(): Promise<void> {
    for (let attempt = 0; attempt <= this.maxPushRetries; attempt++) {
      this.assertLockHeld();
      const auth = await this.auth();
      await gitFetch(this.cloneDir, auth);
      this.assertLockHeld();
      const result = await gitPush(this.cloneDir, this.branchName, auth);
      if (!result.rejected) {
        await this.confirmAllPending();
        return;
      }

      await this.writeSyncState("replaying");
      await this.replayOntoNewTip();

      if (attempt < this.maxPushRetries) {
        await sleep(500 * 2 ** attempt);
      }
    }
    throw new Error(`${TAG} push rejected after ${this.maxPushRetries} replay attempts for ${this.branchName}`);
  }

  private async confirmAllPending(): Promise<void> {
    // Persist the WAL trim BEFORE clearing in-memory state: if the rewrite
    // fails after the push already succeeded, flushLocked's catch marks
    // "push-failed" but pendingOps/uncommittedOpIds must still reflect
    // reality, or every later flush() call would return immediately (both
    // collections already empty) and only a process restart — which
    // reloads the still-populated WAL file — would ever retry the trim.
    await rewriteWalFile(this.walPath, []);
    this.pendingOps = [];
    this.uncommittedOpIds.clear();
    this.lastPushedAt = Date.now();
    if (this.lockLost) {
      this.logger?.warn(
        `${TAG} push for ${this.branchName} succeeded but the lock lease was lost during the attempt; ` +
          `data is safe (git's non-fast-forward push is the real CAS), but the single-writer lease was not held throughout.`,
      );
    }
  }

  /**
   * Push was rejected (non-fast-forward). Reset to the fresh remote tip and
   * replay only the ops that didn't already land there — replay, not a
   * blind merge (RFC结论4). "Already landed" is determined by scanning the
   * new commits' `Ops:` trailers, not by comparing content bytes, so
   * legitimately-duplicate content is never mistaken for an already-applied
   * operation (Codex checkpoint A finding #4).
   */
  private async replayOntoNewTip(): Promise<void> {
    this.assertLockHeld();
    const originRef = `origin/${this.branchName}`;
    const base = await gitMergeBase(this.cloneDir, "HEAD", originRef);
    const alreadyLanded = base ? await gitLogOpIds(this.cloneDir, `${base}..${originRef}`) : new Set<string>();

    const remaining = this.pendingOps.filter((op) => !alreadyLanded.has(op.opId));
    for (const op of this.pendingOps) {
      if (alreadyLanded.has(op.opId)) {
        this.logger?.info(`${TAG} op ${op.opId} already landed on remote, skipping replay`);
      }
    }

    this.assertLockHeld();
    await gitResetHard(this.cloneDir, originRef);

    for (const op of remaining) {
      this.assertLockHeld();
      await this.reapplyOp(op);
    }

    this.pendingOps = remaining;
    this.uncommittedOpIds = new Set(remaining.map((op) => op.opId));
    await rewriteWalFile(this.walPath, remaining);

    if (this.uncommittedOpIds.size > 0) {
      await this.commitUncommittedOps();
    }
  }

  private async reapplyOp(op: WalEntry): Promise<void> {
    const relPath = resolveSafeRelativePath(this.cloneDir, op.key);
    switch (op.kind) {
      case "put":
        await this.inner.putObject(op.key, fromBase64(op.contentBase64 ?? ""), op.opts);
        break;
      case "append":
        await this.inner.appendObject(op.key, fromBase64(op.contentBase64 ?? ""));
        break;
      case "delete": {
        // Same "git add fails on a never-tracked path" hazard as the live
        // deleteObject() path: after gitResetHard, the file may no longer
        // exist at all (e.g. it was created and deleted within the same
        // unpushed batch), in which case there's nothing to stage.
        const existed = await this.inner.exists(op.key);
        await this.inner.deleteObject(op.key);
        if (!existed) return;
        break;
      }
      case "deleteByPrefix": {
        const count = await this.inner.deleteByPrefix(op.key);
        if (count === 0) return;
        break;
      }
    }
    await gitAdd(this.cloneDir, relPath);
  }

  // ── Sync-state persistence ──────────────────────────────────

  private async writeSyncState(status: GitSyncStatus): Promise<void> {
    this.syncStatus = status;
    const payload = JSON.stringify({ status, lastPushedAt: this.lastPushedAt, updatedAt: Date.now() });
    const tmpPath = `${this.syncStatePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, payload);
    await rename(tmpPath, this.syncStatePath);
  }
}
