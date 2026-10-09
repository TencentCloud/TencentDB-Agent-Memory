/**
 * CoreRegistry — routes Gateway requests to a per-account {@link TdaiCore}.
 *
 * This is the structural multi-tenant route from the design doc (§8.4): instead
 * of one shared core + `session_key` filters on every query, each account gets
 * its **own** `TdaiCore` rooted at a dedicated dataDir (`baseDir/{account}`).
 * Isolation is then physical — distinct SQLite files, distinct L0/L1 tables,
 * distinct `persona.md` / `scene_blocks/` — so L1/L2/L3 recall and search are
 * isolated for free, without depending on "every SQL remembered its WHERE".
 *
 * Two modes:
 *   - **single-tenant (default)**: one shared core rooted at `baseDir`,
 *     `session_key` is ignored for routing. Behaviour is identical to the
 *     pre-multi-tenant Gateway.
 *   - **multi-tenant**: lazy `Map<accountDir, TdaiCore>`; `session_key` is
 *     required and mapped to a collision-free, traversal-safe directory.
 *
 * The cross-core LLM extraction concurrency cap lives here too: one
 * {@link AsyncSemaphore} is shared by every core so total background extraction
 * (L1/L2/L3) across all accounts stays bounded (design §8.4 #5).
 *
 * **LRU eviction.** Resident cores are bounded by `maxResidentCores` (opt-in;
 * `0`/unset = unlimited, legacy). When a `getCore` pushes the count over the
 * limit, the least-recently-used *other* core is torn down — `TdaiCore.destroy`
 * first **flushes** its pipeline queues (no buffered L1/L2/L3 work is lost),
 * then releases its SQLite handle. Teardown runs fire-and-forget so it never
 * adds drain latency to the triggering request, but is tracked per key in
 * {@link closing} so a later `getCore`/`wipe` for an evicted account waits for
 * the old handle to close before a fresh core re-opens the same dataDir.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { TdaiCore } from "../core/tdai-core.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { SessionFilter } from "../utils/session-filter.js";
import { AsyncSemaphore } from "../utils/async-semaphore.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { Logger } from "../core/types.js";

/** Map key used for the single shared core when multi-tenant is off. */
const SINGLE_TENANT_KEY = "__single__";

/**
 * Default cap on concurrent background extraction runs (L1/L2/L3) across all
 * resident cores, applied in multi-tenant mode when no explicit limit is
 * configured. Without a cap, `N` active accounts fan out to up to `~3N`
 * simultaneous LLM extraction calls (design §8.4 #5). Single-tenant mode keeps
 * its legacy unbounded behaviour (one core can't fan out).
 */
const DEFAULT_MULTI_TENANT_EXTRACTION_CAP = 4;

/**
 * Default cap on resident per-account cores in multi-tenant mode when none is
 * configured. `0` means **unlimited** — chosen as the default so existing
 * deployments keep every warm core (no surprise evictions / re-init latency).
 * Operators serving many accounts set `data.maxResidentCores` to bound memory.
 */
const DEFAULT_MAX_RESIDENT_CORES = 0;

export interface CoreRegistryOptions {
  /** Root data directory. Single-tenant: the core's dataDir. Multi-tenant: parent of per-account dirs. */
  baseDir: string;
  /** LLM config passed to every core's host adapter. */
  llmConfig: StandaloneLLMConfig;
  /** Parsed memory config shared by every core. */
  memory: MemoryTdaiConfig;
  /** Logger shared by every core. */
  logger: Logger;
  /** When true, route by `session_key` to per-account cores. */
  multiTenant: boolean;
  /** Agents excluded from capture (forwarded to each core's SessionFilter). */
  excludeAgents?: string[];
  /**
   * Max concurrent background extraction runs (L1/L2/L3) across ALL cores.
   *
   * - `> 0`  — hard cap shared by every core.
   * - `0`    — unbounded (the single-tenant default — one core can't fan out).
   * - `undefined` — multi-tenant falls back to
   *   {@link DEFAULT_MULTI_TENANT_EXTRACTION_CAP}; single-tenant stays unbounded.
   */
  maxConcurrentExtractions?: number;
  /**
   * Max number of resident per-account cores kept warm at once (multi-tenant
   * LRU eviction). When a `getCore` would exceed this, the least-recently-used
   * *other* core is flushed + torn down.
   *
   * - `> 0` — keep at most this many cores resident.
   * - `0` / `undefined` — unlimited (legacy: every account stays warm forever).
   *
   * Must exceed the peak number of *concurrently active* accounts, or a core
   * could be evicted mid-request; it bounds idle warm cores, not live ones.
   * Ignored in single-tenant mode (there is only ever one core).
   */
  maxResidentCores?: number;
  /**
   * Idle time-to-live (ms) for resident cores (multi-tenant). A periodic sweep
   * evicts any *unpinned* core whose last request was longer ago than this, so a
   * long-tail of accounts that went quiet are reclaimed during idle periods
   * instead of lingering until an LRU push. Complements {@link maxResidentCores}
   * (count bound): TTL is a time bound.
   *
   * - `> 0` — evict cores idle longer than this.
   * - `0` / `undefined` — disabled (no time-based reclamation; the default).
   *
   * Ignored in single-tenant mode.
   */
  coreIdleTtlMs?: number;
}

interface CoreEntry {
  core: TdaiCore;
  dataDir: string;
  /** Resolves once the core has finished `initialize()`. */
  ready: Promise<void>;
  /** Last time this core served a request (epoch ms) — for LRU eviction. */
  lastUsedMs: number;
  /**
   * Active leases: in-flight requests currently holding this core (see
   * {@link CoreRegistry.acquire}). A core with `pins > 0` is **never** an LRU
   * eviction victim, and manual evict/wipe defers its teardown until pins drain
   * — so a request mid-`capture`/`recall`/`search` can never have its SQLite
   * handle closed underneath it.
   */
  pins: number;
  /** Set while a teardown is waiting for {@link pins} to reach 0; fired by the last release. */
  onIdle?: () => void;
}

/**
 * A held reference to an account's core. The core is guaranteed alive (its store
 * open) until {@link release} is called. Always release exactly once — a
 * `try/finally` around the handler body is the intended usage. Release is
 * idempotent, so a double-release is harmless.
 */
export interface CoreLease {
  core: TdaiCore;
  release: () => void;
}

/**
 * Derive a filesystem-safe, collision-free directory name from a `session_key`.
 *
 * `session_key` is operator/business-supplied (`"ai4all:{account_id}"`), so it
 * must never be trusted as a path segment. We combine:
 *   - a human-readable **slug** (ascii `[A-Za-z0-9._-]`, leading dots removed,
 *     length-capped) for debuggability, and
 *   - a **sha256 prefix** of the *original* key for injectivity.
 *
 * The hash is what guarantees isolation: two distinct keys that sanitise to the
 * same slug (e.g. `a/b` and `a_b`) still get different directories, so they can
 * never share a store. Path-traversal (`/`, `\`, `..`, leading `.`) is stripped
 * from the slug, and the hash suffix means the result is never `.`/`..`/hidden.
 */
export function safeAccountDir(sessionKey: string): string {
  const key = (sessionKey ?? "").trim();
  if (!key) throw new Error("session_key must be a non-empty string");

  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  let slug = key
    .replace(/[^A-Za-z0-9._-]/g, "_") // drop path separators & non-ascii
    .replace(/^\.+/, "_") // never a hidden/`.`/`..` dir
    .slice(0, 48);
  if (!slug) slug = "acct";

  return `${slug}.${hash}`;
}

export class CoreRegistry {
  private readonly opts: CoreRegistryOptions;
  private readonly cores = new Map<string, CoreEntry>();
  /**
   * One limiter shared by every core created here, so background extraction
   * (L1/L2/L3) is globally capped instead of fanning out per account.
   */
  private readonly extractionLimiter: AsyncSemaphore;
  /** Max resident cores (0 = unlimited). Resolved once from options. */
  private readonly maxResidentCores: number;
  /** Idle TTL (ms) for resident cores; 0 = disabled. Resolved once from options. */
  private readonly idleTtlMs: number;
  /** Background idle-sweep timer (multi-tenant + idleTtlMs > 0 only). */
  private idleTimer?: ReturnType<typeof setInterval>;
  /**
   * In-flight teardowns keyed by account, so a re-request (or wipe) for an
   * evicted account waits for its old core to finish closing — releasing the
   * SQLite handle — before a fresh core opens on the same dataDir.
   */
  private readonly closing = new Map<string, Promise<void>>();

  constructor(opts: CoreRegistryOptions) {
    this.opts = opts;
    this.extractionLimiter = new AsyncSemaphore(this.resolveExtractionCap());
    this.maxResidentCores = this.resolveMaxResidentCores();
    this.idleTtlMs = this.resolveIdleTtl();
    this.startIdleSweep();
  }

  /** Resolve the idle TTL. Multi-tenant + explicit positive value; else 0 (off). */
  private resolveIdleTtl(): number {
    if (!this.opts.multiTenant) return 0;
    const explicit = this.opts.coreIdleTtlMs;
    return explicit !== undefined && Number.isFinite(explicit) && explicit > 0
      ? Math.floor(explicit)
      : 0;
  }

  /**
   * Start the background idle sweep when an idle TTL is configured. The interval
   * checks at least every `ttl` (capped at 60s so long TTLs still reclaim within
   * a minute of going idle, floored so tiny test TTLs sweep promptly). `unref()`
   * so the timer never keeps the process alive on its own.
   */
  private startIdleSweep(): void {
    if (this.idleTtlMs <= 0) return;
    const sweepMs = Math.max(50, Math.min(this.idleTtlMs, 60_000));
    this.idleTimer = setInterval(() => this.sweepIdleCores(), sweepMs);
    this.idleTimer.unref?.();
  }

  /**
   * Evict every *unpinned* resident core idle longer than {@link idleTtlMs}.
   * Pinned cores (in-flight requests) are spared — they'll be reclaimed on a
   * later sweep once idle. Returns the number evicted (for tests/metrics). Safe
   * to call directly; the sweep timer just invokes it on a schedule.
   */
  sweepIdleCores(): number {
    if (this.idleTtlMs <= 0) return 0;
    const cutoff = Date.now() - this.idleTtlMs;
    let evicted = 0;
    for (const [key, entry] of [...this.cores]) {
      if (entry.pins > 0) continue; // never evict a live core
      if (entry.lastUsedMs > cutoff) continue; // still within TTL
      this.cores.delete(key);
      void this.beginTeardown(key, entry);
      evicted++;
      this.opts.logger.debug?.(
        `[tdai-gateway] [registry] Idle-evicted ${key} (idle>${this.idleTtlMs}ms, active=${this.cores.size})`,
      );
    }
    return evicted;
  }

  /**
   * Resolve the effective extraction concurrency cap. An explicit value wins;
   * otherwise multi-tenant gets a safe default and single-tenant stays
   * unbounded (a lone core is already serialized by its own SerialQueues).
   */
  private resolveExtractionCap(): number {
    const explicit = this.opts.maxConcurrentExtractions;
    if (explicit !== undefined && Number.isFinite(explicit)) {
      return explicit > 0 ? Math.floor(explicit) : 0;
    }
    return this.opts.multiTenant ? DEFAULT_MULTI_TENANT_EXTRACTION_CAP : 0;
  }

  /**
   * Resolve the resident-core cap. Explicit positive value wins; anything else
   * (0, undefined, negative, non-finite) means unlimited. Single-tenant always
   * resolves to unlimited — there is only one core, so eviction is moot.
   */
  private resolveMaxResidentCores(): number {
    if (!this.opts.multiTenant) return 0;
    const explicit = this.opts.maxResidentCores;
    if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
      return Math.floor(explicit);
    }
    return DEFAULT_MAX_RESIDENT_CORES;
  }

  /**
   * Live resident-core stats (for health/metrics). `limit` 0 = unlimited;
   * `pinned` is how many resident cores currently have in-flight leases (a
   * `pinned` near `count` while `count > limit` means the limiter is holding
   * cores past the cap because they are all busy — transient, expected).
   */
  residentStats(): { count: number; limit: number; pinned: number } {
    let pinned = 0;
    for (const e of this.cores.values()) if (e.pins > 0) pinned++;
    return { count: this.cores.size, limit: this.maxResidentCores, pinned };
  }

  /** Live extraction-limiter stats (for health/metrics). */
  extractionStats(): { limit: number; active: number; waiting: number } {
    return {
      limit: this.extractionLimiter.capacity,
      active: this.extractionLimiter.active,
      waiting: this.extractionLimiter.waiting,
    };
  }

  /** Whether this registry routes per-account. */
  get multiTenant(): boolean {
    return this.opts.multiTenant;
  }

  /** Number of currently-instantiated cores (for health/metrics/LRU). */
  get size(): number {
    return this.cores.size;
  }

  /**
   * Resolve the dataDir a `session_key` maps to — **pure**, no side effects.
   * Useful for the wipe API and tests. In single-tenant mode the argument is
   * ignored and `baseDir` is returned.
   */
  resolveDataDir(sessionKey: string): string {
    return this.resolve(sessionKey).dataDir;
  }

  /**
   * Ensure an entry exists for `session_key` (lazily creating + scheduling its
   * `initialize()`), returning it **synchronously** without awaiting `ready`.
   *
   * Synchronous on purpose: callers increment `pins` in the same tick before
   * the first `await`, so a concurrent `evictLruIfNeeded` (which only runs from
   * this method's own create branch) can never select a just-acquired core.
   */
  private ensureEntry(sessionKey: string): CoreEntry {
    const { key, dataDir } = this.resolve(sessionKey);

    let entry = this.cores.get(key);
    if (!entry) {
      // If this account is mid-eviction, gate the new core's `initialize()`
      // (which opens SQLite) behind the old core's teardown so the same dataDir
      // is never opened twice. The entry is still inserted *synchronously* below
      // — the wait lives inside `ready`, not before the map write — so racing
      // callers find this entry instead of creating a duplicate core.
      const prevClosing = this.closing.get(key);
      const core = this.createCore(dataDir);
      const ready = prevClosing
        ? prevClosing.then(() => core.initialize())
        : core.initialize();
      entry = { core, dataDir, ready, lastUsedMs: Date.now(), pins: 0 };
      this.cores.set(key, entry);
      this.opts.logger.debug?.(
        `[tdai-gateway] [registry] Core created for ${this.multiTenant ? key : "single-tenant"} (dataDir=${dataDir}, active=${this.cores.size})`,
      );
      this.evictLruIfNeeded(key);
    }
    entry.lastUsedMs = Date.now();
    return entry;
  }

  /**
   * Get (lazily creating + initializing) the core for a `session_key`.
   *
   * Concurrent calls for the same key share a single `initialize()`. **Does not
   * pin** — the returned core may be LRU-evicted at any time, so this is only
   * safe for callers that use it synchronously or tolerate eviction (health,
   * single-tenant eager warm-up, tests). Request handlers must use
   * {@link acquire} so the core can't be torn down mid-request.
   */
  async getCore(sessionKey: string): Promise<TdaiCore> {
    const entry = this.ensureEntry(sessionKey);
    await entry.ready;
    return entry.core;
  }

  /**
   * Acquire a **lease** on the core for a `session_key`: like {@link getCore},
   * but pins the core so LRU eviction and manual teardown cannot close its store
   * until the lease is released. This closes the race where one account's
   * request triggers eviction of another account's core while a request is still
   * using it (`maxResidentCores` below peak concurrency). Always release in a
   * `finally`.
   */
  async acquire(sessionKey: string): Promise<CoreLease> {
    const entry = this.ensureEntry(sessionKey);
    entry.pins++; // synchronous, same tick as ensureEntry — no eviction can interleave

    let released = false;
    const release = (): void => {
      if (released) return; // idempotent: only the first call counts
      released = true;
      this.unpin(entry);
    };

    try {
      await entry.ready;
    } catch (err) {
      release(); // init failed — don't leak the pin
      throw err;
    }
    return { core: entry.core, release };
  }

  /**
   * Drop one lease. When the last lease for a core that is awaiting teardown is
   * released, the deferred teardown (set up in {@link beginTeardown}) is woken.
   */
  private unpin(entry: CoreEntry): void {
    if (entry.pins > 0) entry.pins--;
    if (entry.pins === 0 && entry.onIdle) {
      const wake = entry.onIdle;
      entry.onIdle = undefined;
      wake();
    }
  }

  /**
   * Return an already-instantiated core without creating one. Used by the
   * health probe (single-tenant) so it doesn't spin up a core as a side effect.
   */
  peek(sessionKey: string): TdaiCore | undefined {
    return this.cores.get(this.resolve(sessionKey).key)?.core;
  }

  /**
   * Destroy and forget the core for a `session_key` (no-op if not loaded).
   * Returns the dataDir it was bound to, so callers (e.g. the wipe API) can
   * delete it on disk afterwards. Idempotent.
   */
  async evict(sessionKey: string): Promise<string | undefined> {
    const { key } = this.resolve(sessionKey);
    const entry = this.cores.get(key);
    if (!entry) {
      // Not resident — but it may be mid-eviction from the LRU path. Await that
      // teardown so callers (e.g. wipe → rm) see the SQLite handle released.
      await this.closing.get(key)?.catch(() => {});
      return undefined;
    }
    this.cores.delete(key);
    await this.beginTeardown(key, entry);
    return entry.dataDir;
  }

  /**
   * Hard-delete an account: tear down its core (closing the SQLite handle) and
   * remove its dataDir from disk. This is the structural "namespace wipe" that
   * backs the host's account hard-delete (design §8.4 wipe/unbind).
   *
   * - **Multi-tenant only**: in single-tenant mode there is no per-account
   *   dataDir to delete, so this throws rather than risk wiping the shared store.
   * - **Idempotent**: wiping an account with no resident core (or whose dir was
   *   already deleted) still succeeds.
   * - **Bounded**: refuses to delete anything that is not strictly inside
   *   `baseDir`, as a defence-in-depth backstop on top of {@link safeAccountDir}.
   *
   * The core is destroyed *before* the `rm` so the store releases its file
   * handle and {@link TdaiCore.destroy} clears the per-dataDir store cache,
   * letting a later `getCore` for the same key rebuild a fresh empty store.
   */
  async wipe(sessionKey: string): Promise<string> {
    if (!this.opts.multiTenant) {
      throw new Error("namespace wipe requires multi-tenant mode");
    }
    const dataDir = this.resolveDataDir(sessionKey); // throws on empty key

    const root = path.resolve(this.opts.baseDir);
    const target = path.resolve(dataDir);
    if (target === root || !target.startsWith(root + path.sep)) {
      throw new Error(`refusing to wipe path outside baseDir: ${target}`);
    }

    await this.evict(sessionKey); // close core + free slot (no-op if absent)
    await fs.rm(target, { recursive: true, force: true });
    this.opts.logger.debug?.(`[tdai-gateway] [registry] Wiped account dataDir ${target}`);
    return target;
  }

  /** Destroy every loaded core. Call on Gateway shutdown. */
  async destroyAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    const entries = [...this.cores.values()];
    this.cores.clear();
    // Include teardowns already in flight from LRU eviction so shutdown waits
    // for every core (resident + closing) to release its SQLite handle.
    const inFlight = [...this.closing.values()];
    await Promise.allSettled([
      ...inFlight.map((p) => p.catch(() => {})),
      ...entries.map(async (e) => {
        await e.ready.catch(() => {});
        await e.core.destroy();
      }),
    ]);
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Evict least-recently-used cores until the resident count is back within
   * {@link maxResidentCores}. `protectKey` (the core just served) is never a
   * victim, so the caller's own request always survives. No-op when unlimited.
   */
  private evictLruIfNeeded(protectKey: string): void {
    if (this.maxResidentCores <= 0) return; // unlimited
    while (this.cores.size > this.maxResidentCores) {
      let lruKey: string | undefined;
      let lru: CoreEntry | undefined;
      for (const [k, e] of this.cores) {
        if (k === protectKey) continue;
        if (e.pins > 0) continue; // never evict a core with in-flight leases
        if (!lru || e.lastUsedMs < lru.lastUsedMs) {
          lruKey = k;
          lru = e;
        }
      }
      // No evictable (unpinned) victim: every other core is busy. Stop and allow
      // a transient over-limit rather than tear down a live request — the cap
      // bounds *idle* warm cores, and correctness wins over the memory bound.
      if (!lruKey || !lru) break;
      this.cores.delete(lruKey);
      void this.beginTeardown(lruKey, lru);
      this.opts.logger.debug?.(
        `[tdai-gateway] [registry] LRU-evicted ${lruKey} (active=${this.cores.size}, limit=${this.maxResidentCores})`,
      );
    }
  }

  /**
   * Flush + destroy a core out of band, tracking the teardown in {@link closing}
   * so re-creation / wipe of the same key waits for the SQLite handle to close.
   * Caller must have already removed the entry from {@link cores}.
   */
  private beginTeardown(key: string, entry: CoreEntry): Promise<void> {
    const done = (async () => {
      // Wait for in-flight leases to release before closing the store, so a
      // request holding this core never hits a closed SQLite handle. LRU
      // eviction only ever tears down UNPINNED cores, so this await is a no-op
      // there; it matters for manual evict()/wipe() of a still-busy account.
      if (entry.pins > 0) {
        await new Promise<void>((resolve) => {
          entry.onIdle = resolve;
        });
      }
      await entry.ready.catch(() => {});
      try {
        await entry.core.destroy(); // flushes pipeline queues, then closes store
      } catch (err) {
        this.opts.logger.warn?.(
          `[tdai-gateway] [registry] Teardown of ${key} failed: ${String(err)}`,
        );
      }
    })();
    this.closing.set(key, done);
    void done.finally(() => {
      // Only clear if this exact teardown is still the tracked one (a newer
      // getCore→evict cycle may have replaced it).
      if (this.closing.get(key) === done) this.closing.delete(key);
    });
    return done;
  }

  private resolve(sessionKey: string): { key: string; dataDir: string } {
    if (!this.opts.multiTenant) {
      return { key: SINGLE_TENANT_KEY, dataDir: this.opts.baseDir };
    }
    const dir = safeAccountDir(sessionKey); // throws on empty — enforced upstream
    return { key: dir, dataDir: path.join(this.opts.baseDir, dir) };
  }

  private createCore(dataDir: string): TdaiCore {
    const adapter = new StandaloneHostAdapter({
      dataDir,
      llmConfig: this.opts.llmConfig,
      logger: this.opts.logger,
      platform: "gateway",
    });
    return new TdaiCore({
      hostAdapter: adapter,
      config: this.opts.memory,
      sessionFilter: new SessionFilter(this.opts.excludeAgents ?? []),
      extractionLimiter: this.extractionLimiter,
    });
  }
}
