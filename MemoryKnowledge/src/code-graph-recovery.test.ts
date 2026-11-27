import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { recoverInterruptedCodeGraphs } from "./code-graph-recovery.js";
import type { CodeGraphRow, IKnowledgeStore } from "./store/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writeIndex(dir: string, marker: string): void {
  const dbPath = join(dir, ".codegraph", "codegraph.db");
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS fixture_marker (value TEXT NOT NULL)");
    db.exec("DELETE FROM fixture_marker");
    db.prepare("INSERT INTO fixture_marker (value) VALUES (?)").run(marker);
  } finally { db.close(); }
}

function readIndexMarker(dir: string): string {
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM fixture_marker").get() as { value: string };
    return row.value;
  } finally { db.close(); }
}

function fixture(status: "pending" | "processing" | "failed" | "ready") {
  const root = mkdtempSync(join(tmpdir(), "knowledge-recovery-"));
  roots.push(root);
  const dir = join(root, "svc-1", "team-1", "cg-1");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "new-commit");
  writeIndex(dir, "new-index");
  mkdirSync(join(`${dir}.previous`, ".git"), { recursive: true });
  writeFileSync(join(`${dir}.previous`, ".git", "HEAD"), "old-commit");
  writeIndex(`${dir}.previous`, "old-index");
  const row = {
    service_id: "svc-1", team_id: "team-1", code_graph_id: "cg-1",
    status, internal_status: status === "processing" ? "promoting" : null,
    has_last_good: true,
    last_sync_at: "2026-01-01T00:00:00Z", sync_error: null,
  } as CodeGraphRow;
  const store = {
    listRecoverableCodeGraphs: () => row.status !== "ready" ? [row] : [],
    listSyncedCodeGraphs: () => row.status === "ready" ? [{
      service_id: row.service_id, team_id: row.team_id, code_graph_id: row.code_graph_id,
    }] : [],
    updateCodeGraphStatus: (_serviceId: string, _id: string, patch: Partial<CodeGraphRow>) => { Object.assign(row, patch); },
    getCodeGraph: (serviceId: string, teamId: string, id: string) =>
      serviceId === row.service_id && teamId === row.team_id && id === row.code_graph_id ? row : null,
  } as unknown as Pick<IKnowledgeStore,
    "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus" | "getCodeGraph"
  >;
  return { root, dir, row, store };
}

function commitSnapshot(dir: string, marker: string): string {
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "marker.txt"), marker);
  execFileSync("git", ["-C", dir, "add", "marker.txt"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=CodeGraph", "-c", "user.email=codegraph@example.test", "commit", "-qm", marker]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

describe("restart recovery", () => {
  it("rolls back an uncommitted promotion and makes the last-good index ready", () => {
    const f = fixture("processing");
    const previousHead = commitSnapshot(`${f.dir}.previous`, "old");
    commitSnapshot(f.dir, "new");
    f.row.commit_hash = previousHead.slice(0, 12);
    const candidate = join(f.root, "svc-1", "team-1", ".cg-00000001.candidate-00000000-0000-4000-8000-000000000001");
    mkdirSync(candidate);

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(previousHead);
    expect(f.row.status).toBe("ready");
    expect(f.row.sync_error).toContain("interrupted by restart");
    expect(existsSync(candidate)).toBe(false);
    expect(readdirSync(join(f.root, "svc-1", "team-1"))).toEqual(["cg-1"]);
  });

  it("restores the old directory if restart lands between the two renames", () => {
    const f = fixture("processing");
    rmSync(f.dir, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(f.row.status).toBe("ready");
  });

  it("removes only the retired snapshot after a committed promotion", () => {
    const f = fixture("ready");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("restores a ready row's only remaining previous snapshot and clears mismatched metadata", () => {
    const f = fixture("ready");
    mkdirSync(join(`${f.dir}.previous`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.previous`, "old-index");
    f.row.commit_hash = "new-commit";
    f.row.stats_json = "{\"nodes\":99}";
    f.row.summary = "new summary";
    rmSync(f.dir, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(f.row.status).toBe("ready");
    expect(f.row.commit_hash).toBeNull();
    expect(f.row.stats_json).toBeNull();
    expect(f.row.last_sync_at).toBeNull();
    expect(f.row.summary).toBeNull();
    expect(f.row.sync_error).toContain("previous snapshot restored");
  });

  it("uses a complete backup when a ready canonical index has lost its database", () => {
    const f = fixture("ready");
    rmSync(join(f.dir, ".codegraph"), { recursive: true, force: true });
    f.row.commit_hash = "new-commit";

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(readIndexMarker(f.dir)).toBe("old-index");
    expect(f.row.status).toBe("ready");
    expect(f.row.commit_hash).toBeNull();
  });

  it("marks a ready row unavailable if neither canonical nor backup survives", () => {
    const f = fixture("ready");
    rmSync(f.dir, { recursive: true, force: true });
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("canonical_missing");
  });

  it("marks a ready row unavailable when its sole canonical database is corrupt", () => {
    const f = fixture("ready");
    const committedC = commitSnapshot(f.dir, "C");
    f.row.commit_hash = committedC.slice(0, 12);
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });
    writeFileSync(join(f.dir, ".codegraph", "codegraph.db"), "not a SQLite database");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("canonical_missing");
    expect(existsSync(f.dir)).toBe(true);
  });

  it("preserves a ready canonical and backup when Git HEAD disagrees with committed metadata", () => {
    const f = fixture("ready");
    const committed = commitSnapshot(f.dir, "committed");
    commitSnapshot(`${f.dir}.previous`, "backup");
    f.row.commit_hash = committed.slice(0, 12);
    const unexpected = commitSnapshot(f.dir, "unexpected");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("canonical_ambiguous");
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(unexpected);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
  });

  it("finishes an interrupted previous-snapshot restore without advertising new metadata", () => {
    const f = fixture("processing");
    f.row.internal_status = "restoring_previous";
    f.row.commit_hash = "new-commit";
    mkdirSync(join(f.dir, ".codegraph"), { recursive: true });
    writeIndex(f.dir, "old-index");
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(f.row.status).toBe("ready");
    expect(f.row.commit_hash).toBeNull();
  });

  it("keeps an incomplete previous snapshot and marks the missing committed index failed", () => {
    const f = fixture("ready");
    rmSync(f.dir, { recursive: true, force: true });
    rmSync(join(`${f.dir}.previous`, ".codegraph"), { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
    expect(f.row.internal_status).toBe("previous_invalid");
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
  });

  it("never replaces a canonical directory with an incomplete failed-promotion backup", () => {
    const f = fixture("failed");
    rmSync(join(`${f.dir}.previous`, ".codegraph"), { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("previous_invalid");
  });

  it("keeps an incomplete promotion backup without exposing its canonical directory", () => {
    const f = fixture("processing");
    rmSync(join(`${f.dir}.previous`, ".codegraph"), { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
  });

  it("restores a suspect snapshot after an interrupted retry but keeps the asset failed", () => {
    const f = fixture("processing");
    f.row.has_last_good = false;
    f.row.commit_hash = "old-commit";
    mkdirSync(join(`${f.dir}.suspect`, ".git"), { recursive: true });
    writeFileSync(join(`${f.dir}.suspect`, ".git", "HEAD"), "suspect-commit");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "suspect-index");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("suspect-commit");
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.commit_hash).toBeNull();
    expect(f.row.last_sync_at).toBeNull();
    expect(f.row.sync_error).toContain("sync required");
  });

  it("finishes a crashed suspect restore without marking it ready", () => {
    const f = fixture("processing");
    f.row.has_last_good = false;
    f.row.internal_status = "restoring_suspect";
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBeNull();
  });

  it("removes a suspect only after the new canonical index is committed", () => {
    const f = fixture("ready");
    mkdirSync(join(`${f.dir}.suspect`, ".git"), { recursive: true });
    writeFileSync(join(`${f.dir}.suspect`, ".git", "HEAD"), "suspect-commit");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "suspect-index");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("restores a ready row's sole suspect but refuses to serve it", () => {
    const f = fixture("ready");
    mkdirSync(join(`${f.dir}.suspect`, ".git"), { recursive: true });
    writeFileSync(join(`${f.dir}.suspect`, ".git", "HEAD"), "suspect-commit");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "suspect-index");
    rmSync(f.dir, { recursive: true, force: true });
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("suspect-commit");
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.commit_hash).toBeNull();
  });

  it("rescues a complete suspect when ready canonical lost its database, but keeps the row failed", () => {
    const f = fixture("ready");
    mkdirSync(join(`${f.dir}.suspect`, ".git"), { recursive: true });
    writeFileSync(join(`${f.dir}.suspect`, ".git", "HEAD"), "suspect-commit");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "suspect-index");
    rmSync(join(f.dir, ".codegraph"), { recursive: true, force: true });
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(readIndexMarker(f.dir)).toBe("suspect-index");
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
  });

  it.each(["missing", "incomplete", "corrupt"] as const)(
    "restores a ready row's verified previous B before stale suspect A when canonical C is %s",
    (failureMode) => {
      const f = fixture("ready");
      const committedC = commitSnapshot(f.dir, "C");
      const committedB = commitSnapshot(`${f.dir}.previous`, "B");
      mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
      writeIndex(`${f.dir}.suspect`, "suspect-A-index");
      commitSnapshot(`${f.dir}.suspect`, "A");
      f.row.commit_hash = committedC.slice(0, 12);
      f.row.stats_json = "{\"nodes\":99}";
      f.row.summary = "C summary";
      if (failureMode === "missing") rmSync(f.dir, { recursive: true, force: true });
      else if (failureMode === "incomplete") rmSync(join(f.dir, ".codegraph"), { recursive: true, force: true });
      else writeFileSync(join(f.dir, ".codegraph", "codegraph.db"), "not a SQLite database");

      expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

      expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
      expect(readIndexMarker(f.dir)).toBe("old-index");
      expect(existsSync(`${f.dir}.previous`)).toBe(false);
      expect(existsSync(`${f.dir}.suspect`)).toBe(false);
      expect(f.row.status).toBe("ready");
      expect(f.row.commit_hash).toBeNull();
      expect(f.row.stats_json).toBeNull();
      expect(f.row.last_sync_at).toBeNull();
      expect(f.row.summary).toBeNull();
    },
  );

  it("preserves ready-row snapshots when previous B has no verifiable Git commit", () => {
    const f = fixture("ready");
    const committedC = commitSnapshot(f.dir, "C");
    commitSnapshot(`${f.dir}.previous`, "B");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "suspect-A-index");
    commitSnapshot(`${f.dir}.suspect`, "A");
    f.row.commit_hash = committedC.slice(0, 12);
    rmSync(join(`${f.dir}.previous`, ".git", "objects"), { recursive: true, force: true });
    rmSync(f.dir, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

    expect(existsSync(f.dir)).toBe(false);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(existsSync(`${f.dir}.suspect`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("previous_ambiguous");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(existsSync(f.dir)).toBe(false);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(existsSync(`${f.dir}.suspect`)).toBe(true);
    expect(f.row.internal_status).toBe("previous_ambiguous");
  });

  it("preserves all snapshots when previous B has a corrupt database", () => {
    const f = fixture("ready");
    const committedC = commitSnapshot(f.dir, "C");
    commitSnapshot(`${f.dir}.previous`, "B");
    writeIndex(`${f.dir}.suspect`, "suspect-A-index");
    commitSnapshot(`${f.dir}.suspect`, "A");
    f.row.commit_hash = committedC.slice(0, 12);
    writeFileSync(join(`${f.dir}.previous`, ".codegraph", "codegraph.db"), "not a SQLite database");
    rmSync(f.dir, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(existsSync(f.dir)).toBe(false);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(existsSync(`${f.dir}.suspect`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.internal_status).toBe("previous_ambiguous");
  });

  it("finishes a ready-row previous restore after status persistence is interrupted", () => {
    const f = fixture("ready");
    const committedC = commitSnapshot(f.dir, "C");
    const committedB = commitSnapshot(`${f.dir}.previous`, "B");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "suspect-A-index");
    commitSnapshot(`${f.dir}.suspect`, "A");
    f.row.commit_hash = committedC.slice(0, 12);
    rmSync(f.dir, { recursive: true, force: true });
    const updateStatus = f.store.updateCodeGraphStatus;
    let interruptFinalUpdate = true;
    const interruptedStore = {
      ...f.store,
      updateCodeGraphStatus: (serviceId: string, id: string, patch: Partial<CodeGraphRow>) => {
        if (patch.status === "ready" && interruptFinalUpdate) {
          interruptFinalUpdate = false;
          throw new Error("process stopped before final status update");
        }
        updateStatus(serviceId, id, patch);
      },
    };

    expect(recoverInterruptedCodeGraphs(interruptedStore, f.root)).toBe(0);
    expect(f.row.internal_status).toBe("restoring_previous");
    expect(existsSync(`${f.dir}.suspect`)).toBe(true);

    expect(recoverInterruptedCodeGraphs(interruptedStore, f.root)).toBe(1);
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
    expect(f.row.status).toBe("ready");
    expect(f.row.commit_hash).toBeNull();
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
  });

  it("does not roll back a committed index if a stale backup exists before a pending retry", () => {
    const f = fixture("pending");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("keeps committed B when copying stopped beside stale suspect A", () => {
    const f = fixture("processing");
    f.row.internal_status = "copying";
    const committedB = commitSnapshot(f.dir, "B");
    f.row.commit_hash = committedB.slice(0, 12);
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "old-index");
    commitSnapshot(`${f.dir}.suspect`, "A");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("restores committed previous B when a promotion stops between renames beside stale suspect A", () => {
    const f = fixture("processing");
    f.row.internal_status = "promoting";
    const committedB = commitSnapshot(`${f.dir}.previous`, "B");
    f.row.commit_hash = committedB.slice(0, 12);
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "untrusted-A-index");
    commitSnapshot(`${f.dir}.suspect`, "A");
    rmSync(f.dir, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
    expect(readIndexMarker(f.dir)).toBe("old-index");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("restores committed previous B when a new canonical C and stale suspect A both exist", () => {
    const f = fixture("processing");
    f.row.internal_status = "promoting";
    const committedB = commitSnapshot(`${f.dir}.previous`, "B");
    f.row.commit_hash = committedB.slice(0, 12);
    commitSnapshot(f.dir, "uncommitted-C");
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "untrusted-A-index");
    commitSnapshot(`${f.dir}.suspect`, "A");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("keeps previous and suspect when neither proves the committed snapshot", () => {
    const f = fixture("processing");
    f.row.internal_status = "promoting";
    f.row.commit_hash = "0123456789ab";
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "untrusted-A-index");
    commitSnapshot(`${f.dir}.suspect`, "A");
    rmSync(f.dir, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(existsSync(f.dir)).toBe(false);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(existsSync(`${f.dir}.suspect`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.internal_status).toBe("suspect_ambiguous");
  });

  it("retains both snapshots if a stale suspect cannot be proven stale", () => {
    const f = fixture("processing");
    f.row.internal_status = "copying";
    f.row.commit_hash = "0123456789ab";
    mkdirSync(join(`${f.dir}.suspect`, ".codegraph"), { recursive: true });
    writeIndex(`${f.dir}.suspect`, "old-index");
    commitSnapshot(`${f.dir}.suspect`, "A");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(existsSync(f.dir)).toBe(true);
    expect(existsSync(`${f.dir}.suspect`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("suspect_ambiguous");
  });

  it("recovers a failed promotion when a previous snapshot was retained", () => {
    const f = fixture("failed");
    f.row.internal_status = "promoting";
    const previousHead = commitSnapshot(`${f.dir}.previous`, "old");
    commitSnapshot(f.dir, "new");
    f.row.commit_hash = previousHead.slice(0, 12);

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(previousHead);
    expect(f.row.status).toBe("ready");
  });

  it("keeps committed B when a failed copy encounters stale previous A", () => {
    const f = fixture("failed");
    f.row.internal_status = "copying";
    commitSnapshot(`${f.dir}.previous`, "A");
    const committedB = commitSnapshot(f.dir, "B");
    f.row.commit_hash = committedB.slice(0, 12);

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(f.row.status).toBe("ready");
    expect(f.row.commit_hash).toBe(committedB.slice(0, 12));
  });

  it.each(["cloning", "copying", "fetching", "indexing"] as const)(
    "keeps a failed %s row failed when files exist but canonical HEAD does not match the committed hash",
    (phase) => {
      const f = fixture("failed");
      const committedA = commitSnapshot(`${f.dir}.previous`, "A");
      const uncommittedB = commitSnapshot(f.dir, "B");
      f.row.internal_status = phase;
      f.row.commit_hash = committedA.slice(0, 12);
      rmSync(`${f.dir}.previous`, { recursive: true, force: true });

      expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

      expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(uncommittedB);
      expect(existsSync(join(f.dir, ".codegraph", "codegraph.db"))).toBe(true);
      expect(f.row.status).toBe("failed");
      expect(f.row.commit_hash).toBe(committedA.slice(0, 12));
    },
  );

  it("retains a stale previous snapshot when a failed copy cannot prove canonical HEAD", () => {
    const f = fixture("failed");
    commitSnapshot(`${f.dir}.previous`, "A");
    commitSnapshot(f.dir, "B");
    f.row.internal_status = "copying";
    f.row.commit_hash = "0123456789ab";

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);

    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.internal_status).toBe("previous_ambiguous");
    expect(f.row.commit_hash).toBe("0123456789ab");
  });

  it("keeps committed B when promoting failed before moving stale previous A", () => {
    const f = fixture("failed");
    f.row.internal_status = "promoting";
    commitSnapshot(`${f.dir}.previous`, "A");
    const committedB = commitSnapshot(f.dir, "B");
    f.row.commit_hash = committedB.slice(0, 12);

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);
    expect(execFileSync("git", ["-C", f.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(committedB);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("preserves both snapshots when neither Git HEAD proves the committed version", () => {
    const f = fixture("failed");
    f.row.internal_status = "promoting";
    commitSnapshot(`${f.dir}.previous`, "A");
    commitSnapshot(f.dir, "B");
    f.row.commit_hash = "0123456789ab";

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(existsSync(f.dir)).toBe(true);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(f.row.status).toBe("failed");
    expect(f.row.has_last_good).toBe(false);
    expect(f.row.internal_status).toBe("previous_ambiguous");
  });

  it("leaves an ordinary failed asset failed when no backup exists", () => {
    const f = fixture("failed");
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
  });

  it("removes a candidate even when its asset row was deleted before a crash", () => {
    const f = fixture("ready");
    const orphan = join(f.root, "svc-1", "team-1", ".cg-00000001.candidate-00000000-0000-4000-8000-000000000002");
    mkdirSync(orphan);
    const noRows = {
      listRecoverableCodeGraphs: () => [],
      listSyncedCodeGraphs: () => [],
      updateCodeGraphStatus: () => {},
      getCodeGraph: () => null,
    } as unknown as Pick<IKnowledgeStore,
      "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus" | "getCodeGraph"
    >;

    expect(recoverInterruptedCodeGraphs(noRows, f.root)).toBe(0);
    expect(existsSync(orphan)).toBe(false);
  });

  it("removes a deleted asset's canonical and backup directories after a crash", () => {
    const f = fixture("ready");
    const teamDir = join(f.root, "svc-1", "team-1");
    const orphan = join(teamDir, "cg-00000001");
    mkdirSync(join(orphan, ".git"), { recursive: true });
    mkdirSync(join(`${orphan}.previous`, ".git"), { recursive: true });
    const noRows = {
      listRecoverableCodeGraphs: () => [],
      listSyncedCodeGraphs: () => [],
      updateCodeGraphStatus: () => {},
      getCodeGraph: () => null,
    } as unknown as Pick<IKnowledgeStore,
      "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus" | "getCodeGraph"
    >;

    expect(recoverInterruptedCodeGraphs(noRows, f.root)).toBe(0);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(`${orphan}.previous`)).toBe(false);
  });

  it("keeps known assets and leaves directories intact if metadata lookup fails", () => {
    const f = fixture("ready");
    const teamDir = join(f.root, "svc-1", "team-1");
    const asset = join(teamDir, "cg-00000001");
    const uncertain = join(teamDir, "cg-00000002");
    mkdirSync(join(asset, ".git"), { recursive: true });
    mkdirSync(join(uncertain, ".git"), { recursive: true });
    const store = {
      listRecoverableCodeGraphs: () => [],
      listSyncedCodeGraphs: () => [],
      updateCodeGraphStatus: () => {},
      getCodeGraph: (_serviceId: string, _teamId: string, id: string) => {
        if (id === "cg-00000002") throw new Error("database unavailable");
        return { code_graph_id: id };
      },
    } as unknown as Pick<IKnowledgeStore,
      "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus" | "getCodeGraph"
    >;

    expect(recoverInterruptedCodeGraphs(store, f.root)).toBe(0);
    expect(existsSync(asset)).toBe(true);
    expect(existsSync(uncertain)).toBe(true);
  });
});
