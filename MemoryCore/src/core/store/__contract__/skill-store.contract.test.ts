/**
 * ISkillStore conformance suite — harness wiring for the SQLite backend.
 *
 * `skill-store.contract.ts` holds the cross-backend clauses (version append →
 * head promotion, head-only listing, BM25 recall, soft archive vs physical
 * delete). It had no caller until now, so none of those clauses were enforced
 * on any backend — including SQLite, the standalone default.
 *
 * Built with `dimensions: 0` for the same reason as the memory-store harness:
 * that mode creates no `skill_vec` virtual table, so the suite runs on a plain
 * Node 22 `node:sqlite` build with no native extension to compile or ship.
 * Vector recall is covered separately where sqlite-vec is available.
 *
 * The store shares one `DatabaseSync` with a `VectorStore` opened on the same
 * file, mirroring production: `skill_meta` / `skill_fts` / `skill_vec` live
 * alongside `l1_records` in `vectors.db` (see the `getRawDb()` escape hatch on
 * VectorStore). Sharing the connection is what gives one sqlite-vec load, one
 * WAL session and cross-table transactions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISkillStore } from "../../skill/types.js";
import type { DatabaseSync } from "node:sqlite";
import { VectorStore } from "../sqlite/memory-store.js";
import { SqliteSkillStore } from "../sqlite/skill-store.js";
import { runSkillStoreContract } from "../../skill/__contract__/skill-store.contract.js";

let dbSeq = 0;

function createSqliteSkillStore(): Promise<ISkillStore> {
  const dir = mkdtempSync(join(tmpdir(), "skill-store-contract-"));
  const dbPath = join(dir, `vectors-${process.pid}-${dbSeq++}.db`);
  const vectorStore = new VectorStore(dbPath, 0);
  vectorStore.init();
  const store = new SqliteSkillStore({ db: vectorStore.getRawDb(), dimensions: 0 });
  store.init();
  return Promise.resolve(store);
}

async function disposeSqliteSkillStore(store: ISkillStore): Promise<void> {
  // The skill store holds no connection of its own; close the shared one.
  const db = (store as unknown as { db: DatabaseSync }).db;
  const dbPath = db.name as string | undefined;
  db.close();
  if (dbPath) {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  }
}

runSkillStoreContract({
  backend: "sqlite",
  createStore: createSqliteSkillStore,
  disposeStore: disposeSqliteSkillStore,
  // SQLite FTS5 is synchronous — no eventual-consistency window to poll for.
  ftsEventuallyConsistent: false,
});
