/**
 * tz-09 Ф5 — operation journal + reconciliation.
 *
 * The four states a crash can leave behind, each checked against the STORE and
 * not against what the journal claims: no row at all, `prepared`, `applied`
 * with the effect missing, `applied` with the effect present. Record counts
 * are asserted before and after because reconciliation must never mutate the
 * store — it only reports.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWritableSqlite } from "../http-utils.js";
import { createRun, readRun, updateRun } from "./run-repo.js";
import { listOps, opIndexBase, operationIdFor, recordOp } from "./oplog.js";
import { reconcileRun } from "./reconcile.js";

const NOW = "2026-08-10T21:00:00.000Z";
const LATER = "2026-08-10T21:05:00.000Z";
const RUN = "run-recovery";
const DIGEST = "cand-digest";
const COUNTS = {
  merge: 0,
  rewriteRecord: 0,
  deleteL1: 1,
  rewriteBlock: 0,
  rewritePersona: 0,
};

describe("oplog recovery (tz-09 Ф5)", () => {
  let dir: string;

  function seedStore(ids: string[]): void {
    const db = openWritableSqlite(path.join(dir, "vectors.db"));
    try {
      db.exec(
        `CREATE TABLE IF NOT EXISTS l1_records (
           record_id TEXT PRIMARY KEY, content TEXT NOT NULL)`,
      );
      for (const id of ids) {
        db.prepare(
          `INSERT INTO l1_records (record_id, content) VALUES (?, ?)`,
        ).run(id, "text");
      }
    } finally {
      db.close();
    }
  }

  function recordCount(): number {
    const db = openWritableSqlite(path.join(dir, "vectors.db"));
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM l1_records`).get() as {
        n: number;
      };
      return row.n;
    } finally {
      db.close();
    }
  }

  function deleteRecord(id: string): void {
    const db = openWritableSqlite(path.join(dir, "vectors.db"));
    try {
      db.prepare(`DELETE FROM l1_records WHERE record_id = ?`).run(id);
    } finally {
      db.close();
    }
  }

  function journal(state: "prepared" | "applied"): void {
    recordOp(
      dir,
      {
        runId: RUN,
        candidateDigest: DIGEST,
        opIndex: opIndexBase(COUNTS, "deleteL1"),
        opType: "deleteL1",
        state,
        targetKey: "rec-1",
      },
      NOW,
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-oplog-"));
    fs.mkdirSync(path.join(dir, ".metadata"), { recursive: true });
    seedStore(["rec-1", "rec-2"]);
    createRun(
      dir,
      {
        runId: RUN,
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: "{}",
        binding: "{}",
      },
      NOW,
    );
    updateRun(dir, RUN, { state: "needs-reconciliation" }, NOW);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("crash before the journal: nothing to verify, run stays parked", () => {
    const report = reconcileRun(dir, RUN, LATER);
    expect(report.total).toBe(0);
    expect(report.resolved).toBe(false);
    expect(readRun(dir, RUN)?.state).toBe("needs-reconciliation");
    expect(recordCount()).toBe(2);
  });

  it("crash after `prepared`: the delete never happened → unresolved", () => {
    journal("prepared");
    const report = reconcileRun(dir, RUN, LATER);
    expect(report.total).toBe(1);
    expect(report.verified).toBe(0);
    expect(report.unresolved[0]?.detail).toContain("still present");
    expect(report.resolved).toBe(false);
    expect(readRun(dir, RUN)?.state).toBe("needs-reconciliation");
    expect(recordCount()).toBe(2);
  });

  it("`applied` but the effect is absent → unresolved, journal not advanced", () => {
    journal("applied");
    const report = reconcileRun(dir, RUN, LATER);
    expect(report.resolved).toBe(false);
    expect(listOps(dir, RUN)[0]?.state).toBe("applied");
    expect(recordCount()).toBe(2);
  });

  it("`applied` and the effect holds → verified, ambiguity gone, re-run a no-op", () => {
    journal("applied");
    deleteRecord("rec-1");
    const before = recordCount();

    const report = reconcileRun(dir, RUN, LATER);
    expect(report.total).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.unresolved).toEqual([]);
    expect(report.resolved).toBe(true);
    // Terminal and unambiguous — but not "applied": the ops that never
    // started have no row to verify, so the run stays a failure with a known
    // store (reconcile.ts).
    expect(readRun(dir, RUN)?.state).toBe("failed");

    const ops = listOps(dir, RUN);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.state).toBe("verified");
    expect(recordCount()).toBe(before);

    // Idempotence: the second pass adds no rows and changes no records.
    const again = reconcileRun(dir, RUN, LATER);
    expect(again.verified).toBe(1);
    expect(listOps(dir, RUN)).toHaveLength(1);
    expect(recordCount()).toBe(before);
  });

  it("a `prepared` write cannot demote an `applied` operation", () => {
    journal("applied");
    journal("prepared");
    expect(listOps(dir, RUN)[0]?.state).toBe("applied");
  });

  it("operationId is derived, so the same op replayed collides by design", () => {
    const a = operationIdFor(RUN, DIGEST, 0);
    const b = operationIdFor(RUN, DIGEST, 0);
    const other = operationIdFor(RUN, "different-candidate", 0);
    expect(a).toBe(b);
    expect(other).not.toBe(a);
  });
});
