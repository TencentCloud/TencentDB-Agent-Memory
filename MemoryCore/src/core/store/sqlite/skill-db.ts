import path from "node:path";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { StoreLogger } from "../types.js";

const require = createRequire(import.meta.url);

export function openSkillDatabase(
  dbPath: string,
  dimensions: number,
  logger?: StoreLogger,
): { db: DatabaseSync; dimensions: number } {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync: DbSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DbSync(dbPath, { allowExtension: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  if (dimensions <= 0) return { db, dimensions: 0 };
  try {
    db.enableLoadExtension(true);
    require("sqlite-vec").load(db);
    return { db, dimensions };
  } catch (err) {
    logger?.warn?.(`[memory-tdai][skill-db] sqlite-vec unavailable (${err instanceof Error ? err.message : String(err)}); skills use BM25 only`);
    return { db, dimensions: 0 };
  }
}
