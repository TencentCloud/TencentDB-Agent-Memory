/**
 * HookCacheRepo — persistence layer for prewarmed injection blocks.
 *
 * Keyed by (spaceId, userId, agentSource, sessionId, hookId). Blocks are stored as
 * JSON for protocol-agnostic round-trip.
 *
 * Failure semantics: any DB error degrades silently (returns null / no-op).
 * Callers (pipeline) treat "no cache" as equivalent to `cacheStrategy=none`
 * for that hook, matching the existing "hook failure → no injection" rule.
 *
 * ── Signature note ─────────────────────────────────────────────────────────
 * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.6：所有接口
 * 第一个参数是 `spaceId`（P4 kernel-sts 新增），与 SessionRepo / BindingRepo
 * 保持一致；空 spaceId 上下文会被 sessionDirOf 内部当作 `_default` 兜底段处理。
 */

import type Database from "better-sqlite3";

import type { ContextBlock } from "../injection/types.js";
import { getDb } from "./index.js";

export interface HookCacheEntry {
  hookId: string;
  blocks: ContextBlock[];
}

export interface HookCacheRepo {
  put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): void | Promise<void>;
  putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): void | Promise<void>;
  get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null>;
  getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]>;
  clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void | Promise<void>;
}

/** Sqlite 后端下用的复合 session id —— 与 SessionRepo 一致，多加一段 spaceId. */
function compositeSid(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sp}:${userId}:${agentSource}:${sessionId}`;
}

const UPSERT_SQL = `
INSERT INTO hook_cache (session_id, hook_id, blocks_json, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id, hook_id) DO UPDATE SET
  blocks_json = excluded.blocks_json,
  created_at  = excluded.created_at
`;

class SqliteHookCacheRepo implements HookCacheRepo {
  private putStmt: Database.Statement;
  private getStmt: Database.Statement;
  private getAllStmt: Database.Statement;
  private clearStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.putStmt = db.prepare(UPSERT_SQL);
    this.getStmt = db.prepare(
      "SELECT blocks_json FROM hook_cache WHERE session_id = ? AND hook_id = ?",
    );
    this.getAllStmt = db.prepare(
      "SELECT hook_id, blocks_json FROM hook_cache WHERE session_id = ?",
    );
    this.clearStmt = db.prepare("DELETE FROM hook_cache WHERE session_id = ?");
  }

  put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): void {
    try {
      this.putStmt.run(
        compositeSid(spaceId, userId, agentSource, sessionId),
        hookId,
        JSON.stringify(blocks),
        Date.now(),
      );
    } catch (err) {
      console.warn(
        `[hook-cache] put failed (space=${spaceId} user=${userId} agent=${agentSource} session=${sessionId} hook=${hookId}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): void {
    if (entries.length === 0) return;
    try {
      const cs = compositeSid(spaceId, userId, agentSource, sessionId);
      const tx = this.db.transaction((items: HookCacheEntry[]) => {
        const now = Date.now();
        for (const e of items) {
          this.putStmt.run(cs, e.hookId, JSON.stringify(e.blocks), now);
        }
      });
      tx(entries);
    } catch (err) {
      console.warn(
        `[hook-cache] putMany failed (space=${spaceId} user=${userId} agent=${agentSource} session=${sessionId} count=${entries.length}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    try {
      const row = this.getStmt.get(
        compositeSid(spaceId, userId, agentSource, sessionId),
        hookId,
      ) as { blocks_json: string } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.blocks_json) as ContextBlock[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    try {
      const rows = this.getAllStmt.all(
        compositeSid(spaceId, userId, agentSource, sessionId),
      ) as Array<{ hook_id: string; blocks_json: string }>;
      const out: HookCacheEntry[] = [];
      for (const r of rows) {
        try {
          const blocks = JSON.parse(r.blocks_json) as ContextBlock[];
          if (Array.isArray(blocks)) {
            out.push({ hookId: r.hook_id, blocks });
          }
        } catch {
          /* skip corrupt row */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    try {
      this.clearStmt.run(compositeSid(spaceId, userId, agentSource, sessionId));
    } catch {
      /* ignore */
    }
  }
}

class NullHookCacheRepo implements HookCacheRepo {
  put(): void {}
  putMany(): void {}
  async get(): Promise<ContextBlock[] | null> {
    return null;
  }
  async getAllForSession(): Promise<HookCacheEntry[]> {
    return [];
  }
  clearBySession(): void {}
}

let _repo: HookCacheRepo | null = null;

export function getHookCacheRepo(): HookCacheRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteHookCacheRepo(db) : new NullHookCacheRepo();
  return _repo;
}

/** Replace the singleton with a Redis-backed repo (called at injection pipeline init). */
export function setHookCacheRepo(repo: HookCacheRepo): void {
  _repo = repo;
}

/** Reset singleton — tests only. */
export function __resetHookCacheRepoForTests(): void {
  _repo = null;
}
