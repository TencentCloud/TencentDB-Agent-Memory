import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../db/client.js";
import { BuildQueue } from "./build-queue.js";
import { CodeGraphService } from "./code-graph-service.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { recoverInterruptedCodeGraphs } from "../code-graph-recovery.js";
import { createCodeGraphWorker } from "../code-graph-worker.js";
import { resolveCodeGraphQueryAccess } from "../routes/tools.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { ISourceFetcher } from "../source-fetcher/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CodeGraph refresh admission", () => {
  it("atomically removes serving eligibility when retrying a failed asset", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-failed-admission-"));
    roots.push(root);
    const connection = createDb({ path: join(root, "knowledge.sqlite") });
    try {
      const store = new SqliteKnowledgeStore(connection.db);
      const row = store.createCodeGraph({
        service_id: "svc-1", team_id: "team-1", repo_url: "https://example.com/repo.git", branch: "main",
      }).row;
      store.updateCodeGraphStatus("svc-1", row.code_graph_id, {
        status: "failed", has_last_good: true, commit_hash: "prior-success",
      });

      expect(store.tryAdmitCodeGraphSync("svc-1", "team-1", row.code_graph_id, row.version)).toBe(true);
      expect(store.getCodeGraphById("svc-1", row.code_graph_id)).toMatchObject({
        status: "pending", has_last_good: false, commit_hash: "prior-success",
      });
    } finally {
      connection.raw.close();
    }
  });

  it("retries failed canonical through a real worker without deleting its only snapshot on fetch failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-failed-worker-"));
    roots.push(root);
    const connection = createDb({ path: join(root, "knowledge.sqlite") });
    let failFetch!: (error: Error) => void;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const stalledFetch = new Promise<never>((_resolve, reject) => { failFetch = reject; });
    try {
      const store = new SqliteKnowledgeStore(connection.db);
      const created = store.createCodeGraph({
        service_id: "svc-1", team_id: "team-1", repo_url: "https://example.com/repo.git", branch: "main",
      }).row;
      const dir = join(root, "svc-1", "team-1", created.code_graph_id);
      mkdirSync(join(dir, ".git"), { recursive: true });
      mkdirSync(join(dir, ".codegraph"), { recursive: true });
      writeFileSync(join(dir, "only-snapshot"), "keep this version");
      writeFileSync(join(dir, ".codegraph", "codegraph.db"), "old index");
      store.updateCodeGraphStatus("svc-1", created.code_graph_id, {
        status: "failed", has_last_good: true, commit_hash: "old-commit",
      });
      const pool = {
        get: () => undefined, set: () => {}, delete: () => {},
        pause: async () => {}, resume: () => {},
      } as CodeGraphInstancePool;
      const fetcher = {
        supportedType: "git", validate: () => {},
        fetch: async () => { fetchStarted(); return stalledFetch; },
        sync: async () => { throw new Error("failed retry must start with a fresh candidate"); },
      } as ISourceFetcher;
      const worker = createCodeGraphWorker({
        instancePool: pool, resolveFetcher: () => fetcher,
        indexOps: {
          openIndex: async () => { throw new Error("not reached"); },
          indexProject: async () => { throw new Error("not reached"); },
          syncIndex: async () => ({ changed: 0 }),
          closeIndex: () => {}, getStats: () => ({}),
        },
      });
      const service = new CodeGraphService({ store, dataRoot: root, worker });

      expect((await service.sync("svc-1", "team-1", created.code_graph_id)).kind).toBe("ok");
      await started;
      const inFlight = store.getCodeGraphById("svc-1", created.code_graph_id)!;
      expect(inFlight.status).toBe("processing");
      expect(inFlight.has_last_good).toBe(false);
      const access = await resolveCodeGraphQueryAccess("svc-1", inFlight, service, pool);
      expect("response" in access && (await access.response.json()).error_code).toBe("CODE_GRAPH_INDEX_BUILDING");

      failFetch(new Error("network unavailable"));
      await service.onIdle(created.code_graph_id);
      expect(store.getCodeGraphById("svc-1", created.code_graph_id)).toMatchObject({
        status: "failed", has_last_good: false,
      });
      expect(readFileSync(join(dir, "only-snapshot"), "utf8")).toBe("keep this version");
      expect(existsSync(`${dir}.suspect`)).toBe(false);
      expect(existsSync(`${dir}.previous`)).toBe(false);
      expect(readdirSync(join(root, "svc-1", "team-1"))).toEqual([created.code_graph_id]);
    } finally {
      failFetch?.(new Error("test teardown"));
      connection.raw.close();
    }
  });

  it("admits one of two services sharing a SQLite database and separate queues", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-admission-"));
    roots.push(root);
    const path = join(root, "knowledge.sqlite");
    const firstDb = createDb({ path });
    const secondDb = createDb({ path });
    let releaseWorker: (() => void) | undefined;
    const holdWorker = new Promise<void>((resolve) => { releaseWorker = resolve; });
    try {
      const firstStore = new SqliteKnowledgeStore(firstDb.db);
      const secondStore = new SqliteKnowledgeStore(secondDb.db);
      const created = firstStore.createCodeGraph({
        service_id: "svc-1", team_id: "team-1", repo_url: "https://example.com/repo.git", branch: "main",
      }).row;
      firstStore.updateCodeGraphStatus("svc-1", created.code_graph_id, {
        status: "ready", commit_hash: "old-commit", has_last_good: true, last_sync_at: "2026-01-01T00:00:00Z",
      });
      expect(secondStore.tryAdmitCodeGraphSync("another-service", "team-1", created.code_graph_id, created.version)).toBe(false);
      expect(secondStore.tryAdmitCodeGraphSync("svc-1", "another-team", created.code_graph_id, created.version)).toBe(false);
      expect(secondStore.tryAdmitCodeGraphSync("svc-1", "team-1", created.code_graph_id, created.version + 1)).toBe(false);

      const worker = vi.fn(async () => {
        await holdWorker;
        return { commitHash: "new-commit" };
      });
      const first = new CodeGraphService({ store: firstStore, dataRoot: root, queue: new BuildQueue(), worker });
      const second = new CodeGraphService({ store: secondStore, dataRoot: root, queue: new BuildQueue(), worker });

      const [a, b] = await Promise.all([
        first.sync("svc-1", "team-1", created.code_graph_id),
        second.sync("svc-1", "team-1", created.code_graph_id),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["busy", "ok"]);
      const admitted = firstStore.getCodeGraph("svc-1", "team-1", created.code_graph_id)!;
      expect(admitted.version).toBe(created.version + 1);
      expect(["pending", "processing"]).toContain(admitted.status);
      expect(firstStore.listCodeGraphAudit("svc-1", created.code_graph_id).filter((entry) => entry.action === "ingest")).toHaveLength(1);
      expect(worker).toHaveBeenCalledTimes(1);

      releaseWorker?.();
      await Promise.all([first.onIdle(), second.onIdle()]);
      expect(firstStore.getCodeGraph("svc-1", "team-1", created.code_graph_id)?.status).toBe("ready");
      expect(firstStore.getCodeGraph("svc-1", "team-1", created.code_graph_id)?.has_last_good).toBe(true);
    } finally {
      releaseWorker?.();
      firstDb.raw.close();
      secondDb.raw.close();
    }
  });

  it("backfills the persisted last-good flag only for legacy ready rows", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-migration-"));
    roots.push(root);
    const path = join(root, "knowledge.sqlite");
    const legacy = createDb({ path });
    try {
      // Model a database created before has_last_good was introduced.
      legacy.raw.exec("ALTER TABLE knowledge_code_graph DROP COLUMN has_last_good");
      const insert = legacy.raw.prepare(`
        INSERT INTO knowledge_code_graph
          (code_graph_id, service_id, team_id, repo_url, branch, status, version, created_at, updated_at)
        VALUES (?, 'svc-1', 'team-1', ?, 'main', ?, 0, '2026-01-01', '2026-01-01')
      `);
      insert.run("cg-legacyready", "https://example.com/legacy.git", "ready");
      insert.run("cg-firstbuild", "https://example.com/first.git", "pending");
    } finally {
      legacy.raw.close();
    }

    const migrated = createDb({ path });
    try {
      const store = new SqliteKnowledgeStore(migrated.db);
      expect(store.getCodeGraphById("svc-1", "cg-legacyready")?.last_sync_at).toBeNull();
      expect(store.getCodeGraphById("svc-1", "cg-legacyready")?.has_last_good).toBe(true);
      expect(store.getCodeGraphById("svc-1", "cg-firstbuild")?.has_last_good).toBe(false);
    } finally {
      migrated.raw.close();
    }
  });

  it("recovers an interrupted refresh with no last-sync timestamp but not an initial build", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-persisted-recovery-"));
    roots.push(root);
    const connection = createDb({ path: join(root, "knowledge.sqlite") });
    try {
      const store = new SqliteKnowledgeStore(connection.db);
      const makeAsset = (name: string) => store.createCodeGraph({
        service_id: "svc-1", team_id: "team-1", repo_url: `https://example.com/${name}.git`, branch: "main",
      }).row;
      const firstBuild = makeAsset("initial");
      const refreshed = makeAsset("refresh");
      let refreshedCommit = "";
      for (const row of [firstBuild, refreshed]) {
        const dir = join(root, "svc-1", "team-1", row.code_graph_id);
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q", dir]);
        writeFileSync(join(dir, "source.ts"), "export const value = 1;\n");
        execFileSync("git", ["-C", dir, "add", "source.ts"]);
        execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
        if (row.code_graph_id === refreshed.code_graph_id) {
          refreshedCommit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().slice(0, 12);
        }
        const indexDir = join(dir, ".codegraph");
        mkdirSync(indexDir, { recursive: true });
        const indexDb = createDb({ path: join(indexDir, "codegraph.db") });
        indexDb.raw.close();
      }
      store.updateCodeGraphStatus("svc-1", refreshed.code_graph_id, {
        status: "ready", has_last_good: true, last_sync_at: null, commit_hash: refreshedCommit,
      });
      expect(store.tryAdmitCodeGraphSync("svc-1", "team-1", refreshed.code_graph_id, refreshed.version)).toBe(true);

      expect(store.listRecoverableCodeGraphs().map((row) => row.code_graph_id).sort()).toEqual(
        [firstBuild.code_graph_id, refreshed.code_graph_id].sort(),
      );
      expect(recoverInterruptedCodeGraphs(store, root)).toBe(1);
      expect(store.getCodeGraphById("svc-1", refreshed.code_graph_id)?.status).toBe("ready");
      expect(store.getCodeGraphById("svc-1", firstBuild.code_graph_id)?.status).toBe("pending");
      store.markInterruptedAsFailed();
      expect(store.getCodeGraphById("svc-1", firstBuild.code_graph_id)?.status).toBe("failed");
    } finally {
      connection.raw.close();
    }
  });
});
