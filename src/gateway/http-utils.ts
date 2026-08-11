/**
 * Shared HTTP helpers for the TDAI gateway server.
 *
 * Extracted from server.ts so route modules (memory-routes.ts etc.) can
 * reuse the exact same response/body/safe-compare primitives without
 * creating import cycles with the server class.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import type { GatewayErrorResponse } from "./types.js";

/** Parse a JSON request body. Rejects with an Error on malformed JSON. */
export async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message } satisfies GatewayErrorResponse);
}

// Runtime-agnostic SQLite loader (single source of truth; same pattern as
// src/core/store/sqlite.ts): bun:sqlite under Bun (the systemd gateway
// runtime), node:sqlite under Node (vitest forks). Only readonly diagnostic
// queries are used by the memory routes and /status totals.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const require = createRequire(import.meta.url);

export interface ReadonlySqlite {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/** Open a SQLite database in readonly mode on the current runtime. */
export function openReadonlySqlite(dbPath: string): ReadonlySqlite {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string, o?: { readonly?: boolean }) => unknown;
    };
    return new Database(dbPath, {
      readonly: true,
    }) as unknown as ReadonlySqlite;
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => unknown;
  };
  return new DatabaseSync(dbPath, {
    readOnly: true,
  }) as unknown as ReadonlySqlite;
}

/** Writable SQLite connection (feedback priority bumps; never used on records files). */
export interface WritableSqlite {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    /** node:sqlite and bun:sqlite both report the affected row count here —
     * the only way a conditional UPDATE can tell "matched nothing" from
     * "wrote the value it already had". */
    run(...params: unknown[]): { changes?: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
}

/**
 * Two concurrent writers are the DESIGNED case here: the control plane is
 * opened per call and closed again, from every gateway process on the same
 * dataDir. Without these two pragmas SQLite defaults to rollback journal and a
 * ZERO busy timeout, so the second process fails instantly with "database is
 * locked" — a run that dies mid-flight, not a run that waits. Reproduced by
 * role-lock.cross-process.test.ts: two workers, two roles, ~1 in 5 runs lost
 * at recordAttempt (attempt-repo.ts:22). Same posture as VectorStore
 * (sqlite.ts:497).
 */
function tuneForConcurrency(db: WritableSqlite): WritableSqlite {
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch (err) {
    db.close(); // иначе handle течёт: конструктор уже отработал
    throw err;
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // КОНВЕРСИЯ журнала (delete → WAL) требует эксклюзивной блокировки и НЕ
    // идёт через busy handler: при соседе с открытой транзакцией она падает
    // мгновенно, сколько бы ни стоял busy_timeout. Раньше открытие такой базы
    // не бросало никогда — превращать это в отказ нельзя. База остаётся в
    // старом журнале, busy_timeout выше уже стоит, а конверсия случится при
    // первом же открытии без соседа. Новые базы рождаются в WAL сразу.
  }
  return db;
}

export function openWritableSqlite(dbPath: string): WritableSqlite {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string) => unknown;
    };
    return tuneForConcurrency(
      new Database(dbPath) as unknown as WritableSqlite,
    );
  }
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => unknown;
  };
  return tuneForConcurrency(
    new DatabaseSync(dbPath) as unknown as WritableSqlite,
  );
}

/**
 * Constant-time string equality for secrets.
 *
 * Returns `false` on any length mismatch (without comparing bytes), and uses
 * `crypto.timingSafeEqual` for the equal-length case so that an attacker
 * probing the token cannot use response timing to learn a prefix match.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
