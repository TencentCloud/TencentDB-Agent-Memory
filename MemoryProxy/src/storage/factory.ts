/** Local Proxy storage: SQLite, filesystem or transient memory. */

import { createRequire } from "node:module";
import type { ProxyStorage, ProxyStorageType } from "./proxy-storage.js";
import { MemoryStorage } from "./memory-storage.js";
import { FsStorage } from "./fs-storage.js";
import { SqliteStorage } from "./sqlite-storage.js";

const TAG = "[storage]";
const _require = createRequire(import.meta.url);

/**
 * 用户配置结构 —— kernel-sts 段见
 * docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.1。
 *
 * COS 后端只支持 kernel-sts —— static AK/SK 已删除（正式环境禁止）。
 * 本地/离线开发用 `backend: sqlite`（或 fs / memory）。
 */
export interface StorageConfig {
  backend: ProxyStorageType;
  /** `ttl/` 前缀下对象的生存期（天）。只对 ttl 前缀生效。 */
  ttlDays: number;

  sqlite: {
    /** empty = use getDb() default (~/.tdai-memory-proxy/proxy.db) */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

let _instance: ProxyStorage | null = null;
let _requested: ProxyStorageType = "memory";
let _effective: ProxyStorageType = "memory";
let _lastError: string | undefined;
let _sweepTimer: NodeJS.Timeout | null = null;
export async function initProxyStorage(config: StorageConfig & {enabled?:boolean}): Promise<ProxyStorage> { return getProxyStorage(config); }

export function getProxyStorage(config: StorageConfig & { enabled?: boolean }): ProxyStorage {
  if ((config.backend as string) === "cos") throw new Error("Proxy COS storage was removed. Migrate to sqlite, fs or memory before startup.");
  if (_instance) return _instance;
  _requested = config.backend;

  if (config.enabled === false) {
    console.log(`${TAG} storage disabled by config, using memory backend for fallback`);
    _instance = new MemoryStorage();
    _effective = "memory";
    return _instance;
  }

  // ── 非 cos：本地/离线开发，保留降级链 sqlite → fs → memory ────────────────
  const chain: ProxyStorageType[] = orderFrom(config.backend);
  for (const backend of chain) {
    try {
      const created = tryCreate(backend, config);
      if (!created) continue;
      if (backend !== _requested) {
        // 降级 = 高危事件，用 error 级别（老代码是 warn，被淹没了）
        console.error(
          `${TAG} !!! DEGRADED !!! backend ${_requested} unavailable — using ${backend} instead${_lastError ? ` (${_lastError})` : ""}`,
        );
        if (backend === "memory" || backend === "fs" || backend === "sqlite") {
          console.error(
            `${TAG} !!! MULTI-NODE HAZARD !!! effective backend=${backend} is process-local;`
            + ` other proxy nodes have their own copy — cross-node reads WILL miss.`,
          );
        }
      } else {
        console.log(`${TAG} activated ${backend} backend`);
      }
      _effective = backend;
      _instance = created;
      startSweeperIfNeeded(created, config);
      return created;
    } catch (err) {
      _lastError = err instanceof Error ? err.message : String(err);
      // 装配失败也升级为 error（之前是 warn）
      console.error(`${TAG} backend ${backend} init failed: ${_lastError}`);
    }
  }

  // 理论上到不了这里 —— MemoryStorage 不会抛
  console.error(
    `${TAG} !!! LAST-RESORT !!! all backends failed; falling back to in-process memory.`
    + ` Data will NOT persist across restarts and will NOT be visible to other nodes.`,
  );
  _instance = new MemoryStorage();
  _effective = "memory";
  return _instance;
}

export function getEffectiveBackend(): { requested: string; effective: string; error?: string } {
  return { requested: _requested, effective: _effective, error: _lastError };
}

/** 测试专用 —— 重置单例 + 停 sweeper。 */
export function __resetProxyStorageForTests(): void {
  _instance = null;
  _requested = "memory";
  _effective = "memory";
  _lastError = undefined;
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

// ── internals ──────────────────────────────────────────────────────────────

function orderFrom(preferred: ProxyStorageType): ProxyStorageType[] {
  const all: ProxyStorageType[] = ["sqlite", "fs", "memory"];
  const start = all.indexOf(preferred);
  if (start < 0) return all;
  return all.slice(start);
}

function tryCreate(backend: ProxyStorageType, config: StorageConfig): ProxyStorage | null {
  switch (backend) {
    case "memory":
      return new MemoryStorage();
    case "fs": {
      if (!config.fs?.fsRoot) throw new Error("fs.fsRoot not configured");
      return new FsStorage(config.fs.fsRoot);
    }
    case "sqlite": {
      const db = openSqliteDb(config.sqlite?.dbPath);
      return new SqliteStorage(db);
    }
  }
}

function openSqliteDb(dbPath: string): any {
  // Lazy require —— better-sqlite3 是 optional dependency，某些镜像加载会失败。
  let Database: any;
  try {
    Database = _require("better-sqlite3");
  } catch (err) {
    throw new Error(`better-sqlite3 unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (dbPath && dbPath.trim().length > 0) return new Database(dbPath);
  // 默认路径复用 db/index.ts 的 resolveDbPath 逻辑：环境变量 > ~/.tdai-memory-proxy/proxy.db。
  // 不通过 require ../db/index.js —— tsx 下 ESM 会失败 —— 直接内联一次。
  const os = _require("node:os");
  const path = _require("node:path");
  const fs = _require("node:fs");
  const fromEnv = process.env.PROXY_DB_PATH;
  const resolved =
    fromEnv && fromEnv.trim().length > 0
      ? fromEnv.trim()
      : path.join(os.homedir(), ".tdai-memory-proxy", "proxy.db");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return new Database(resolved);
}


// 主仓通过 initProxyStorage() dynamic import 拿到 _kernelStsFactory 使用。

function startSweeperIfNeeded(storage: ProxyStorage, config: StorageConfig): void {
  if (storage.type !== "sqlite") return;
  if (_sweepTimer) return; // already running
  const ttlMs = config.ttlDays * 86400 * 1000;
  const run = () => {
    try {
      // 只清 ttl bucket；nottl 永久保留（与 COS lifecycle rule 的语义一致）。
      (storage as SqliteStorage).sweep({ ttlMs });
    } catch (err) {
      console.warn(`${TAG} sweeper error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  _sweepTimer = setInterval(run, 5 * 60 * 1000);
  // don't hold the event loop just for the sweeper
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}
