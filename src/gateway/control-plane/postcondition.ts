/**
 * Postconditions (tz-09 Ф5, P7/P8).
 *
 * "The call returned" is not evidence: after a crash the only trustworthy
 * statement about an operation is what the STORE says now. Each op type has
 * one read-back check, and the check is deliberately about the effect, not
 * about the call — a delete is verified by the record being gone, whoever
 * removed it.
 */
import fs from "node:fs";
import path from "node:path";
import { openReadonlySqlite } from "../http-utils.js";
import type { OpRow } from "./oplog.js";

export interface PostconditionResult {
  operationId: string;
  opIndex: number;
  opType: OpRow["opType"];
  holds: boolean;
  detail: string;
}

/** Does the L1 record still exist? Read-only, never throws. */
function recordExists(dataDir: string, id: string): boolean | null {
  const dbPath = path.join(dataDir, "vectors.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = openReadonlySqlite(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT 1 AS present FROM l1_records WHERE record_id = ? LIMIT 1`,
        )
        .get(id);
      return row !== undefined && row !== null;
    } finally {
      db.close();
    }
  } catch {
    return null; // unreadable store — "unknown", never "verified"
  }
}

function fileExists(dataDir: string, relPath: string): boolean {
  return fs.existsSync(path.join(dataDir, relPath));
}

export function checkPostcondition(
  dataDir: string,
  op: OpRow,
): PostconditionResult {
  const base = {
    operationId: op.operationId,
    opIndex: op.opIndex,
    opType: op.opType,
  };
  switch (op.opType) {
    case "deleteL1": {
      const present = recordExists(dataDir, op.targetKey);
      if (present === null)
        return { ...base, holds: false, detail: "store unreadable" };
      return {
        ...base,
        holds: !present,
        detail: present
          ? `record "${op.targetKey}" still present`
          : "record gone",
      };
    }
    case "merge":
    case "rewriteRecord": {
      const present = recordExists(dataDir, op.targetKey);
      if (present === null)
        return { ...base, holds: false, detail: "store unreadable" };
      return {
        ...base,
        holds: present,
        detail: present ? "target present" : `target "${op.targetKey}" missing`,
      };
    }
    case "rewriteBlock":
    case "rewritePersona": {
      const present = fileExists(dataDir, op.targetKey);
      return {
        ...base,
        holds: present,
        detail: present ? "file present" : `file "${op.targetKey}" missing`,
      };
    }
  }
}
