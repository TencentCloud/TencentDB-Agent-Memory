/**
 * IMemoryStore conformance suite — harness wiring for the SQLite backend.
 *
 * `memory-store.contract.ts` holds the cross-backend clauses (L0/L1 roundtrip,
 * BM25/FTS recall, isolation pushdown, L2/L3 profile sync, clearMemoryContent).
 * It had no caller until now, so none of those clauses were enforced on any
 * backend — including SQLite, which is the standalone default.
 *
 * The store is built with `dimensions: 0`. That is a supported metadata +
 * FTS-only mode: `VectorStore.init()` skips the sqlite-vec extension entirely
 * when dimensions is 0 (see the comment in `init()`), so this harness runs on
 * a plain Node 22 `node:sqlite` build with no native dependency to compile or
 * ship. Vector search is covered separately, per backend, where the extension
 * is available.
 *
 * FTS on SQLite is synchronous, so `ftsEventuallyConsistent` stays false and
 * the suite's search assertions run single-shot rather than polling.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IMemoryStore } from "../types.js";
import { VectorStore } from "../sqlite/memory-store.js";
import { runMemoryStoreContract } from "./memory-store.contract.js";

let dbSeq = 0;

function createSqliteStore(): Promise<IMemoryStore> {
  const dir = mkdtempSync(join(tmpdir(), "memory-store-contract-"));
  const dbPath = join(dir, `vectors-${process.pid}-${dbSeq++}.db`);
  const store = new VectorStore(dbPath, 0);
  store.init();
  return Promise.resolve(store);
}

async function disposeSqliteStore(store: IMemoryStore): Promise<void> {
  const raw = (store as VectorStore).getRawDb();
  const dbPath = raw.name as string | undefined;
  raw.close();
  if (dbPath) {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    // The mkdtemp directory itself (parent of the db file).
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
}

runMemoryStoreContract({
  backend: "sqlite",
  createStore: createSqliteStore,
  disposeStore: disposeSqliteStore,
  // SQLite FTS5 is synchronous — no eventual-consistency window to poll for.
  ftsEventuallyConsistent: false,
});
