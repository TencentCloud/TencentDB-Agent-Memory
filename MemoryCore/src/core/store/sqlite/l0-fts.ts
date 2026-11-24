import type { DatabaseSync, StatementSync } from "node:sqlite";
import { tokenizeForFts } from "../tokenize.js";

// Keep the projection in the same order as VectorStore's L0 search binds.
const columns = [
  "message_text", "message_text_original", "record_id", "session_key", "session_id", "team_id",
  "task_id", "user_id", "agent_id", "role", "recorded_at", "timestamp",
];
const upsertDocument = `
  INSERT INTO l0_fts_documents (${columns.join(", ")})
  VALUES (${columns.map(() => "?").join(", ")})
  ON CONFLICT(record_id) DO UPDATE SET
    ${columns.filter(name => name !== "record_id").map(name => `${name} = excluded.${name}`).join(", ")}
`;

function populateDocuments(db: DatabaseSync, upsert: StatementSync): number {
  const records = db.prepare(`
    SELECT message_text, record_id, session_key, session_id, team_id, task_id,
           user_id, agent_id, role, recorded_at, timestamp FROM l0_conversations
  `);
  let count = 0;
  for (const row of records.iterate()) {
    const text = String(row.message_text);
    upsert.run(tokenizeForFts(text), text, row.record_id, row.session_key, row.session_id,
      row.team_id ?? "", row.task_id ?? "", row.user_id ?? "", row.agent_id ?? "",
      row.role, row.recorded_at, row.timestamp);
    count++;
  }
  return count;
}

export function initializeL0Fts(db: DatabaseSync): StatementSync {
  // Acquire the writer lock before inspecting the schema so two processes can upgrade together.
  db.exec("BEGIN IMMEDIATE");
  try {
    const installed = db.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'
      AND name IN ('l0_fts', 'l0_fts_documents')
    `).get();
    if (installed?.n === 2) {
      const upsert = db.prepare(upsertDocument);
      db.exec("COMMIT");
      return upsert;
    }

    // Metadata is authoritative. Re-tokenizing it also removes orphan/duplicate legacy hits.
    // DDL, content and index are published together; an interrupted upgrade can retry.
    db.exec(`
      DROP TABLE IF EXISTS l0_fts;
      DROP TABLE IF EXISTS l0_fts_documents;
      CREATE TABLE l0_fts_documents (
        docid INTEGER PRIMARY KEY, message_text TEXT, message_text_original TEXT,
        record_id TEXT NOT NULL UNIQUE, session_key TEXT, session_id TEXT, team_id TEXT,
        task_id TEXT, user_id TEXT, agent_id TEXT, role TEXT, recorded_at TEXT, timestamp INTEGER
      );
      CREATE VIRTUAL TABLE l0_fts USING fts5(
        message_text, message_text_original UNINDEXED, record_id UNINDEXED, session_key UNINDEXED,
        session_id UNINDEXED, team_id UNINDEXED, task_id UNINDEXED, user_id UNINDEXED,
        agent_id UNINDEXED, role UNINDEXED, recorded_at UNINDEXED, timestamp UNINDEXED,
        content='l0_fts_documents', content_rowid='docid'
      );
      CREATE TRIGGER l0_search_insert AFTER INSERT ON l0_fts_documents BEGIN
        INSERT INTO l0_fts(rowid, message_text) VALUES (new.docid, new.message_text);
      END;
      CREATE TRIGGER l0_search_delete AFTER DELETE ON l0_fts_documents BEGIN
        INSERT INTO l0_fts(l0_fts, rowid, message_text) VALUES ('delete', old.docid, old.message_text);
      END;
      CREATE TRIGGER l0_search_update AFTER UPDATE OF message_text ON l0_fts_documents
      WHEN old.message_text IS NOT new.message_text BEGIN
        INSERT INTO l0_fts(l0_fts, rowid, message_text) VALUES ('delete', old.docid, old.message_text);
        INSERT INTO l0_fts(rowid, message_text) VALUES (new.docid, new.message_text);
      END;
    `);
    const upsert = db.prepare(upsertDocument);
    populateDocuments(db, upsert);
    db.exec("COMMIT");
    return upsert;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function rebuildL0Fts(db: DatabaseSync, upsert: StatementSync): number {
  db.exec("SAVEPOINT rebuild_l0_fts");
  try {
    db.exec("DELETE FROM l0_fts_documents");
    const count = populateDocuments(db, upsert);
    db.exec("RELEASE rebuild_l0_fts");
    return count;
  } catch (error) {
    db.exec("ROLLBACK TO rebuild_l0_fts");
    db.exec("RELEASE rebuild_l0_fts");
    throw error;
  }
}
