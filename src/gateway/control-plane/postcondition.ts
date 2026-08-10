/**
 * Postconditions (tz-09 Ф5, P7/P8).
 *
 * "The call returned" is not evidence: after a crash the only trustworthy
 * statement about an operation is what the STORE says now. Each op type has
 * one read-back check, and the check is about the EFFECT, not the call — a
 * delete is verified by the record being gone, whoever removed it.
 *
 * Existence alone is not an effect: a merge target and a rewrite target both
 * exist BEFORE the operation, so "the row is there" would verify nothing. The
 * journal therefore carries the digest of the content each operation writes,
 * and verification means the store holds exactly that content.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { openReadonlySqlite } from "../http-utils.js";
import { extraKeysOf, type OpRow } from "./oplog.js";

export interface PostconditionResult {
  operationId: string;
  opIndex: number;
  opType: OpRow["opType"];
  holds: boolean;
  detail: string;
}

const sha = (content: string) =>
  createHash("sha256").update(content).digest("hex");

/** Current content of an L1 record; null when unreadable, undefined when the
 * record is gone. Read-only, never throws. */
function recordContent(dataDir: string, id: string): string | null | undefined {
  const dbPath = path.join(dataDir, "vectors.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = openReadonlySqlite(dbPath);
    try {
      const row = db
        .prepare(`SELECT content FROM l1_records WHERE record_id = ? LIMIT 1`)
        .get(id) as { content?: string } | undefined;
      return row === undefined ? undefined : (row.content ?? "");
    } finally {
      db.close();
    }
  } catch {
    return null; // unreadable store — "unknown", never "verified"
  }
}

function fileContent(dataDir: string, relPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(dataDir, relPath), "utf-8");
  } catch {
    return undefined;
  }
}

/** Compare what the store holds against what the operation wrote. An op
 * journalled without a digest (pre-digest rows) can only be checked for
 * presence, and says so in the detail — a weak check must never read as a
 * strong one. */
function matches(
  current: string | undefined,
  payloadDigest: string,
  what: string,
): { holds: boolean; detail: string } {
  if (current === undefined) return { holds: false, detail: `${what} missing` };
  if (payloadDigest === "") {
    return { holds: true, detail: `${what} present (no digest journalled)` };
  }
  const actual = sha(current);
  return actual === payloadDigest
    ? { holds: true, detail: `${what} matches the written content` }
    : {
        holds: false,
        detail: `${what} content differs (journal ${payloadDigest.slice(0, 12)}, store ${actual.slice(0, 12)})`,
      };
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
      const current = recordContent(dataDir, op.targetKey);
      if (current === null) {
        return { ...base, holds: false, detail: "store unreadable" };
      }
      return {
        ...base,
        holds: current === undefined,
        detail:
          current === undefined
            ? "record gone"
            : `record "${op.targetKey}" still present`,
      };
    }
    case "merge": {
      const current = recordContent(dataDir, op.targetKey);
      if (current === null) {
        return { ...base, holds: false, detail: "store unreadable" };
      }
      const target = matches(
        current,
        op.payloadDigest,
        `merge target "${op.targetKey}"`,
      );
      if (!target.holds) return { ...base, ...target };
      // A merge has TWO effects: the target carries the merged content AND the
      // cluster members are gone. Checking only the target verifies half the
      // operation, and a crash inside deleteL1Batch would read as resolved.
      const survivors = extraKeysOf(op).filter((id) => {
        const member = recordContent(dataDir, id);
        return member !== undefined;
      });
      if (survivors.length > 0) {
        return {
          ...base,
          holds: false,
          detail: `merge target "${op.targetKey}" written, but member(s) still present: ${survivors.join(", ")}`,
        };
      }
      return { ...base, ...target };
    }
    case "rewriteRecord": {
      const current = recordContent(dataDir, op.targetKey);
      if (current === null) {
        return { ...base, holds: false, detail: "store unreadable" };
      }
      return {
        ...base,
        ...matches(current, op.payloadDigest, `record "${op.targetKey}"`),
      };
    }
    case "rewriteBlock":
    case "rewritePersona": {
      return {
        ...base,
        ...matches(
          fileContent(dataDir, op.targetKey),
          op.payloadDigest,
          `file "${op.targetKey}"`,
        ),
      };
    }
  }
}
