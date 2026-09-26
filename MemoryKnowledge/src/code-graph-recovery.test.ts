import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverInterruptedCodeGraphs } from "./code-graph-recovery.js";
import type { CodeGraphRow, IKnowledgeStore } from "./store/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(status: "pending" | "processing" | "failed" | "ready") {
  const root = mkdtempSync(join(tmpdir(), "knowledge-recovery-"));
  roots.push(root);
  const dir = join(root, "svc-1", "team-1", "cg-1");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "new-commit");
  mkdirSync(join(`${dir}.previous`, ".git"), { recursive: true });
  writeFileSync(join(`${dir}.previous`, ".git", "HEAD"), "old-commit");
  const row = {
    service_id: "svc-1", team_id: "team-1", code_graph_id: "cg-1",
    status, internal_status: status === "processing" ? "promoting" : null,
    last_sync_at: "2026-01-01T00:00:00Z", sync_error: null,
  } as CodeGraphRow;
  const store = {
    listRecoverableCodeGraphs: () => row.status !== "ready" ? [row] : [],
    listSyncedCodeGraphs: () => row.status === "ready" ? [{
      service_id: row.service_id, team_id: row.team_id, code_graph_id: row.code_graph_id,
    }] : [],
    updateCodeGraphStatus: (_serviceId: string, _id: string, patch: Partial<CodeGraphRow>) => { Object.assign(row, patch); },
  } as unknown as Pick<IKnowledgeStore,
    "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus"
  >;
  return { root, dir, row, store };
}

describe("restart recovery", () => {
  it("rolls back an uncommitted promotion and makes the last-good index ready", () => {
    const f = fixture("processing");
    const candidate = join(f.root, "svc-1", "team-1", ".cg-1.candidate-orphan");
    mkdirSync(candidate);

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
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

  it("does not roll back a committed index if a stale backup exists before a pending retry", () => {
    const f = fixture("pending");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(f.row.status).toBe("ready");
  });

  it("recovers a failed promotion when a previous snapshot was retained", () => {
    const f = fixture("failed");

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(1);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(f.row.status).toBe("ready");
  });

  it("leaves an ordinary failed asset failed when no backup exists", () => {
    const f = fixture("failed");
    rmSync(`${f.dir}.previous`, { recursive: true, force: true });

    expect(recoverInterruptedCodeGraphs(f.store, f.root)).toBe(0);
    expect(f.row.status).toBe("failed");
  });
});
