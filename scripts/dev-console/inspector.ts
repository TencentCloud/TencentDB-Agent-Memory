/**
 * dev-console / inspector — read-only disk readers for the memory pyramid.
 *
 * Reads a single account's on-disk dataDir and reports the L0/L1/L2/L3 layers
 * so the console UI can visualise the pyramid building up after each turn.
 *
 * This NEVER writes. The SQLite handle is opened with `PRAGMA query_only = ON`
 * (the proven pattern from `scripts/read-local-memory/read-local-memory.ts`),
 * so it is safe to read `vectors.db` while the Gateway holds it open for writes
 * — SQLite allows concurrent readers. Every layer is wrapped in try/catch and
 * degrades to empty so a brand-new account (missing db / files) reads as zeros
 * rather than erroring.
 *
 * Layout (verified against source), all relative to the account dataDir:
 *   L0  conversations/YYYY-MM-DD.jsonl  +  vectors.db table `l0_conversations`
 *   L1  vectors.db table `l1_records`
 *   L2  scene_blocks/*.md              +  .metadata/scene_index.json
 *   L3  persona.md
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeAccountDir } from "../../src/gateway/core-registry.js";

const require = createRequire(import.meta.url);
function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}

const SQLITE_DB_NAME = "vectors.db";
const SCENE_DIR = "scene_blocks";
const SCENE_INDEX_REL = path.join(".metadata", "scene_index.json");
const PERSONA_FILE = "persona.md";
const CONVERSATIONS_DIR = "conversations";

const RECENT_LIMIT = 20;

export interface L1Atom {
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  updated_time: string;
}

export interface SceneMeta {
  filename: string;
  summary: string;
  heat: number;
  updated: string;
}

export interface L0Turn {
  role: string;
  content: string;
  recorded_at: string;
}

export interface AccountSummary {
  /** The true session_key (recovered from on-disk data — safeAccountDir is lossy). */
  sessionKey: string;
  /** Friendly label: the part after the last ":" (e.g. "User2993"), else the full key. */
  display: string;
  /** Namespace prefix before the first ":" (e.g. "psydt"), or "" when unprefixed. */
  namespace: string;
  /** On-disk directory name under baseDir. */
  dir: string;
  counts: { l0: number; l1: number; l2: number; l3: number };
}

export interface InspectResult {
  sessionKey: string;
  accountDir: string;
  /** Whether the account's dataDir exists on disk at all. */
  exists: boolean;
  counts: { l0: number; l1: number; l2: number; l3: number };
  l1ByType: { type: string; count: number }[];
  l1Recent: L1Atom[];
  scenes: SceneMeta[];
  persona: { text: string; chars: number } | null;
  l0Recent: L0Turn[];
  /** Non-fatal problems encountered while reading (shown as hints in the UI). */
  notes: string[];
}

/**
 * Map a session_key to its on-disk dataDir. Single-tenant: the shared baseDir.
 * Multi-tenant: `baseDir/{safeAccountDir(key)}` — the SAME function the Gateway
 * uses, so the console always points at the exact directory the Gateway writes.
 */
export function resolveAccountDir(
  sessionKey: string,
  baseDir: string,
  multiTenant: boolean,
): string {
  if (!multiTenant) return baseDir;
  return path.join(baseDir, safeAccountDir(sessionKey));
}

function openReadonly(dbPath: string): DatabaseSync | null {
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync: DbSync } = requireNodeSqlite();
  const db = new DbSync(dbPath, { open: false });
  db.open();
  db.exec("PRAGMA query_only = ON");
  return db;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
}

/** Read L0 + L1 from vectors.db. Returns zeros if the db is absent. */
function readSqliteLayers(
  dataDir: string,
  notes: string[],
): Pick<InspectResult, "l1ByType" | "l1Recent" | "l0Recent"> & {
  l0Count: number;
  l1Count: number;
} {
  const empty = { l1ByType: [], l1Recent: [], l0Recent: [], l0Count: 0, l1Count: 0 };
  let db: DatabaseSync | null = null;
  try {
    db = openReadonly(path.join(dataDir, SQLITE_DB_NAME));
    if (!db) return empty;

    const l0Count = num((db.prepare("SELECT COUNT(*) AS c FROM l0_conversations").get() as any)?.c);
    const l1Count = num((db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as any)?.c);

    const l1ByType = (db
      .prepare("SELECT type, COUNT(*) AS c FROM l1_records GROUP BY type ORDER BY c DESC")
      .all() as any[]).map((r) => ({ type: String(r.type ?? ""), count: num(r.c) }));

    const l1Recent = (db
      .prepare(
        "SELECT content, type, priority, scene_name, updated_time FROM l1_records " +
          "ORDER BY updated_time DESC LIMIT ?",
      )
      .all(RECENT_LIMIT) as any[]).map((r) => ({
      content: String(r.content ?? ""),
      type: String(r.type ?? ""),
      priority: num(r.priority),
      scene_name: String(r.scene_name ?? ""),
      updated_time: String(r.updated_time ?? ""),
    }));

    const l0Recent = (db
      .prepare(
        "SELECT role, message_text, recorded_at FROM l0_conversations " +
          "ORDER BY timestamp DESC LIMIT ?",
      )
      .all(RECENT_LIMIT) as any[]).map((r) => ({
      role: String(r.role ?? ""),
      content: String(r.message_text ?? ""),
      recorded_at: String(r.recorded_at ?? ""),
    }));

    return { l1ByType, l1Recent, l0Recent, l0Count, l1Count };
  } catch (err) {
    notes.push(`sqlite read failed: ${String((err as Error)?.message ?? err)}`);
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Count L0 turns from the newest JSONL shard — fallback when there is no db. */
function countL0FromJsonl(dataDir: string): { count: number; recent: L0Turn[] } {
  try {
    const dir = path.join(dataDir, CONVERSATIONS_DIR);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    let count = 0;
    let lastLines: string[] = [];
    for (const f of files) {
      const lines = fs
        .readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      count += lines.length;
      lastLines = lines;
    }
    const recent: L0Turn[] = lastLines
      .slice(-RECENT_LIMIT)
      .reverse()
      .map((l) => {
        try {
          const o = JSON.parse(l);
          return { role: String(o.role ?? ""), content: String(o.content ?? ""), recorded_at: String(o.recordedAt ?? "") };
        } catch {
          return { role: "", content: l.slice(0, 200), recorded_at: "" };
        }
      });
    return { count, recent };
  } catch {
    return { count: 0, recent: [] };
  }
}

/** Read L2 scenes from the index (preferred) or by scanning scene_blocks/. */
function readScenes(dataDir: string, notes: string[]): SceneMeta[] {
  try {
    const indexPath = path.join(dataDir, SCENE_INDEX_REL);
    if (fs.existsSync(indexPath)) {
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (Array.isArray(raw)) {
        return raw.map((e: any) => ({
          filename: String(e.filename ?? ""),
          summary: String(e.summary ?? ""),
          heat: num(e.heat),
          updated: String(e.updated ?? ""),
        }));
      }
    }
    // No index yet — list the raw scene block files so the count still shows.
    const blocksDir = path.join(dataDir, SCENE_DIR);
    if (fs.existsSync(blocksDir)) {
      return fs
        .readdirSync(blocksDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({ filename: f, summary: "(no index entry)", heat: 0, updated: "" }));
    }
  } catch (err) {
    notes.push(`scene read failed: ${String((err as Error)?.message ?? err)}`);
  }
  return [];
}

function readPersona(dataDir: string, notes: string[]): { text: string; chars: number } | null {
  try {
    const p = path.join(dataDir, PERSONA_FILE);
    if (!fs.existsSync(p)) return null;
    const text = fs.readFileSync(p, "utf8");
    if (text.trim().length === 0) return null;
    return { text, chars: text.length };
  } catch (err) {
    notes.push(`persona read failed: ${String((err as Error)?.message ?? err)}`);
    return null;
  }
}

/**
 * Inspect one account's on-disk memory pyramid. Pure read-only; safe to call
 * repeatedly (e.g. an auto-refresh loop) while the Gateway is live.
 */
export function inspectAccount(
  sessionKey: string,
  baseDir: string,
  multiTenant: boolean,
): InspectResult {
  const notes: string[] = [];
  const accountDir = resolveAccountDir(sessionKey, baseDir, multiTenant);
  const exists = fs.existsSync(accountDir);

  const sql = readSqliteLayers(accountDir, notes);

  // L0: prefer the sqlite index; fall back to JSONL when the db is missing.
  let l0Count = sql.l0Count;
  let l0Recent = sql.l0Recent;
  if (l0Count === 0 && l0Recent.length === 0) {
    const jsonl = countL0FromJsonl(accountDir);
    l0Count = jsonl.count;
    l0Recent = jsonl.recent;
  }

  const scenes = readScenes(accountDir, notes);
  const persona = readPersona(accountDir, notes);

  return {
    sessionKey,
    accountDir,
    exists,
    counts: {
      l0: l0Count,
      l1: sql.l1Count,
      l2: scenes.length,
      l3: persona ? 1 : 0,
    },
    l1ByType: sql.l1ByType,
    l1Recent: sql.l1Recent,
    scenes,
    persona,
    l0Recent,
    notes,
  };
}

/**
 * Recover the true session_key for an account dir. `safeAccountDir` is a lossy
 * one-way hash (`psydt:User2993` → `psydt_User2993.<sha>`), so the dir name
 * alone can't be turned back into a key. Both the SQLite `l0_conversations`
 * table and the L0 JSONL store the original `session_key` per row — read one.
 */
function recoverSessionKey(accountDir: string): string | null {
  // Prefer sqlite (single row, indexed).
  let db: DatabaseSync | null = null;
  try {
    db = openReadonly(path.join(accountDir, SQLITE_DB_NAME));
    if (db) {
      const row = db.prepare("SELECT session_key FROM l0_conversations LIMIT 1").get() as any;
      const key = row?.session_key ? String(row.session_key) : "";
      if (key) return key;
    }
  } catch {
    /* fall through to JSONL */
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  // Fallback: first JSONL line carries `sessionKey`.
  try {
    const dir = path.join(accountDir, CONVERSATIONS_DIR);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const first = fs.readFileSync(path.join(dir, f), "utf8").split("\n").find((l) => l.trim());
      if (first) {
        const key = String(JSON.parse(first).sessionKey ?? "");
        if (key) return key;
      }
    }
  } catch {
    /* no recoverable key */
  }
  return null;
}

/**
 * List every account with on-disk memory under `baseDir`, recovering each one's
 * true session_key so the console can offer a real-account picker (the dir name
 * is a lossy hash and cannot be reversed). Single-tenant has no per-account
 * dirs, so it returns an empty list (the UI falls back to the free-text key).
 *
 * `seed-*` snapshot dirs (written by the single-dir /seed pipeline) and hidden
 * dirs are skipped. Read-only and cheap — safe to call on an auto-refresh.
 */
export function listAccounts(baseDir: string, multiTenant: boolean): AccountSummary[] {
  if (!multiTenant) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: AccountSummary[] = [];
  const seen = new Set<string>();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || ent.name.startsWith("seed-")) continue;

    const accountDir = path.join(baseDir, ent.name);
    const sessionKey = recoverSessionKey(accountDir);
    if (!sessionKey || seen.has(sessionKey)) continue;
    seen.add(sessionKey);

    const info = inspectAccount(sessionKey, baseDir, multiTenant);
    const colon = sessionKey.indexOf(":");
    out.push({
      sessionKey,
      display: colon >= 0 ? sessionKey.slice(colon + 1) : sessionKey,
      namespace: colon >= 0 ? sessionKey.slice(0, colon) : "",
      dir: ent.name,
      counts: info.counts,
    });
  }

  // Group by namespace, then by display — stable, readable ordering in the picker.
  out.sort((a, b) =>
    a.namespace === b.namespace
      ? a.display.localeCompare(b.display, undefined, { numeric: true })
      : a.namespace.localeCompare(b.namespace),
  );
  return out;
}
