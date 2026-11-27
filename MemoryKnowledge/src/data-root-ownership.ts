/** Process-lifetime ownership of one CodeGraph data root.
 *
 * SQLite's writer lock is released by the OS when a process exits, including
 * after SIGKILL. A separate tiny database keeps the metadata database free to
 * process normal writes while preventing a second process from running startup
 * recovery or promoting candidates in the same filesystem tree.
 */

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface DataRootOwnership {
  readonly path: string;
  release(): void;
}

function acquireSqliteOwnership(lockPath: string, description: string): DataRootOwnership {
  const lockDb = new Database(lockPath, { timeout: 0 });
  try {
    // A RESERVED writer lock excludes every other owner and survives for this
    // connection's lifetime. SQLite releases it automatically on process death.
    lockDb.exec("BEGIN IMMEDIATE");
  } catch (err) {
    lockDb.close();
    throw new Error(`${description} is already owned by another MemoryKnowledge process`, { cause: err });
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try { lockDb.exec("ROLLBACK"); }
      finally { lockDb.close(); }
    },
  };
}

export function acquireDataRootOwnership(dataDir: string): DataRootOwnership {
  mkdirSync(dataDir, { recursive: true });
  const root = realpathSync(dataDir);
  return acquireSqliteOwnership(join(root, ".memoryknowledge-owner.sqlite"), `CodeGraph data root ${root}`);
}

/** Both resources need ownership: a separately configured DB can be shared by
 * processes whose data roots differ, and either process could run recovery.
 */
export function acquireKnowledgeStoreOwnership(dataDir: string, dbPath: string): DataRootOwnership {
  const dataRoot = acquireDataRootOwnership(dataDir);
  if (dbPath === ":memory:") return dataRoot;
  try {
    const parent = resolve(dirname(dbPath));
    mkdirSync(parent, { recursive: true });
    const canonicalParent = realpathSync(parent);
    const dbEntry = lstatSync(dbPath, { throwIfNoEntry: false });
    // A dangling symlink reports false from existsSync(), but SQLite follows
    // it and creates the target. Locking the alias would let another process
    // lock the target path and enter the same database concurrently.
    if (dbEntry?.isSymbolicLink()) {
      throw new Error(`Knowledge metadata DB path must not be a symbolic link: ${dbPath}`);
    }
    // A hard link is another pathname for the same DB inode. It would acquire
    // a different owner lock (and SQLite WAL path) while sharing the database.
    if (dbEntry && dbEntry.nlink > 1) {
      throw new Error(`Knowledge metadata DB path must not be hard-linked: ${dbPath}`);
    }
    const canonicalDb = dbEntry ? realpathSync(dbPath) : join(canonicalParent, basename(dbPath));
    const dbOwner = acquireSqliteOwnership(`${canonicalDb}.memoryknowledge-owner.sqlite`, `Knowledge metadata DB ${canonicalDb}`);
    let released = false;
    return {
      path: dataRoot.path,
      release() {
        if (released) return;
        released = true;
        try { dbOwner.release(); }
        finally { dataRoot.release(); }
      },
    };
  } catch (err) {
    dataRoot.release();
    throw err;
  }
}
