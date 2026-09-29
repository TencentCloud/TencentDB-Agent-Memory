import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodeGraphVersionProbe } from "../code-graph-version-probe.js";
import { createDb } from "../db/client.js";
import { GitSourceFetcher } from "../source-fetcher/index.js";
import { AutoSyncScheduler } from "./auto-sync-scheduler.js";
import { CodeGraphService, type CodeGraphWorker } from "./code-graph-service.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";

const roots: string[] = [];
const savedGitEnv = new Map<string, string | undefined>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function setGitEnv(key: string, value: string): void {
  if (!savedGitEnv.has(key)) savedGitEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function createBareRemote() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-auto-sync-acceptance-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", source]);
  git(source, ["config", "user.email", "acceptance@example.invalid"]);
  git(source, ["config", "user.name", "Acceptance Test"]);
  git(source, ["checkout", "-b", "main"]);
  writeFileSync(join(source, "file.txt"), "first\n");
  git(source, ["add", "file.txt"]);
  git(source, ["commit", "-m", "first"]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "-u", "origin", "main"]);

  setGitEnv("GIT_CONFIG_COUNT", "1");
  setGitEnv("GIT_CONFIG_KEY_0", "url.file://.insteadOf");
  setGitEnv("GIT_CONFIG_VALUE_0", "https://probe.invalid");
  setGitEnv("GIT_ALLOW_PROTOCOL", "file:https");

  return { root, remote, source, url: `https://probe.invalid${remote}` };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function candidateEntries(dir: string): string[] {
  const parent = dirname(dir);
  const name = dir.slice(parent.length + 1);
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((entry) =>
    entry.startsWith(`.${name}.candidate-`) || entry === `${name}.previous` || entry === `${name}.suspect`,
  );
}

async function triggerAndWait(
  scheduler: AutoSyncScheduler,
  probe: ReturnType<typeof vi.fn>,
  expectedProbeCalls: number,
): Promise<number> {
  const started = Date.now();
  scheduler.triggerScan();
  await waitFor(
    () => probe.mock.calls.length >= expectedProbeCalls
      && scheduler.getStatus().activeSyncs === 0
      && scheduler.getStatus().queueLength === 0,
    `automatic probe ${expectedProbeCalls}`,
  );
  return Date.now() - started;
}

async function createFixture(workerDelayMs = 0) {
  const remote = createBareRemote();
  const dataRoot = join(remote.root, "data");
  const { db, raw } = createDb({ path: join(remote.root, "metadata.db") });
  const store = new SqliteKnowledgeStore(db);
  const created = store.createCodeGraph({
    service_id: "svc-1", team_id: "team-1", repo_url: remote.url, branch: "main", repo_name: "repo",
  }).row;
  const dir = join(dataRoot, created.service_id, created.team_id, created.code_graph_id);
  mkdirSync(dirname(dir), { recursive: true });
  const fetcher = new GitSourceFetcher({ ssrfCheck: false, probeTimeoutMs: 5_000 });
  const fetched = await fetcher.fetch(remote.url, "main", dir);
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  const indexDb = new Database(join(dir, ".codegraph", "codegraph.db"));
  indexDb.exec("CREATE TABLE acceptance_marker (id INTEGER PRIMARY KEY)");
  indexDb.close();
  store.updateCodeGraphStatus(created.service_id, created.code_graph_id, {
    status: "ready", commit_hash: fetched.version, stats_json: '{"files":1,"nodes":1,"edges":0}',
    has_last_good: true, last_sync_at: "2026-09-28T00:00:00.000Z",
  });

  const worker = vi.fn<CodeGraphWorker>(async (context) => {
    if (workerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, workerDelayMs));
    const refreshed = await fetcher.sync(context.repoUrl, context.branch, context.dir);
    return { commitHash: refreshed.version ?? undefined, stats: { files: 1, nodes: 1, edges: 0 } };
  });
  const productionProbe = createCodeGraphVersionProbe({ resolveFetcher: () => fetcher });
  const probe = vi.fn(productionProbe);
  const service = new CodeGraphService({ store, dataRoot, worker, versionProbe: probe });
  const scheduler = new AutoSyncScheduler({
    store, cgService: service,
    config: { enabled: true, scanIntervalMs: 600_000, maxConcurrentSyncs: 1 },
  });
  scheduler.start();

  return { ...remote, raw, store, dir, row: created, fetcher, worker, probe, service, scheduler };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of savedGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedGitEnv.clear();
  vi.restoreAllMocks();
});

describe.sequential("automatic sync production acceptance", () => {
  it("skips two unchanged scans, refreshes one remote update, and preserves the last-good index on probe failure", async () => {
    const f = await createFixture();
    const admit = vi.spyOn(f.store, "tryAdmitCodeGraphSync");
    const baseline = f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)!;
    try {
      const firstMs = await triggerAndWait(f.scheduler, f.probe, 1);
      const secondMs = await triggerAndWait(f.scheduler, f.probe, 2);
      const afterUnchanged = f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)!;

      expect(firstMs).toBeLessThan(5_000);
      expect(secondMs).toBeLessThan(5_000);
      expect(admit).not.toHaveBeenCalled();
      expect(f.worker).not.toHaveBeenCalled();
      expect(f.store.listCodeGraphAudit("svc-1", f.row.code_graph_id)).toEqual([]);
      expect(candidateEntries(f.dir)).toEqual([]);
      expect(afterUnchanged).toMatchObject({
        status: "ready", version: baseline.version, commit_hash: baseline.commit_hash,
        last_sync_at: baseline.last_sync_at, updated_at: baseline.updated_at,
        auto_sync_probe_error: null, auto_sync_probe_at: null,
      });

      writeFileSync(join(f.source, "file.txt"), "second\n");
      git(f.source, ["commit", "-am", "second"]);
      git(f.source, ["push", "origin", "main"]);
      const secondRevision = git(f.source, ["rev-parse", "HEAD"]);
      await triggerAndWait(f.scheduler, f.probe, 3);
      await f.service.onIdle(f.row.code_graph_id);

      expect(f.worker).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)).toMatchObject({
        status: "ready", commit_hash: secondRevision, version: baseline.version + 1,
        auto_sync_probe_error: null, auto_sync_probe_at: null,
      });
      expect(f.store.listCodeGraphAudit("svc-1", f.row.code_graph_id).map((entry) => entry.action).sort()).toEqual(["ingest", "ready"]);

      await triggerAndWait(f.scheduler, f.probe, 4);
      expect(f.worker).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(1);

      const beforeFailure = f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)!;
      const offlineRemote = `${f.remote}.offline`;
      renameSync(f.remote, offlineRemote);
      await triggerAndWait(f.scheduler, f.probe, 5);
      await waitFor(
        () => f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)?.auto_sync_probe_error !== null,
        "persisted probe diagnostic",
      );
      const afterFailure = f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)!;
      expect(afterFailure.auto_sync_probe_error).toMatch(/^\[network\] /);
      expect(afterFailure.auto_sync_probe_at).not.toBeNull();
      expect(afterFailure).toMatchObject({
        status: "ready", version: beforeFailure.version, commit_hash: beforeFailure.commit_hash,
        last_sync_at: beforeFailure.last_sync_at, updated_at: beforeFailure.updated_at,
      });
      expect(f.worker).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(candidateEntries(f.dir)).toEqual([]);

      renameSync(offlineRemote, f.remote);
      await triggerAndWait(f.scheduler, f.probe, 6);
      await waitFor(
        () => f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)?.auto_sync_probe_error === null,
        "cleared probe diagnostic",
      );
      expect(f.store.getCodeGraph("svc-1", "team-1", f.row.code_graph_id)).toMatchObject({
        status: "ready", version: beforeFailure.version, commit_hash: beforeFailure.commit_hash,
        last_sync_at: beforeFailure.last_sync_at, updated_at: beforeFailure.updated_at,
        auto_sync_probe_error: null, auto_sync_probe_at: null,
      });
      expect(f.worker).toHaveBeenCalledTimes(1);
    } finally {
      f.scheduler.stop();
      f.raw.close();
    }
  }, 20_000);

  it("completes unchanged scans under five seconds and at least fifty percent faster than the prior forceful path", async () => {
    const f = await createFixture(1_000);
    try {
      const firstMs = await triggerAndWait(f.scheduler, f.probe, 1);
      const secondMs = await triggerAndWait(f.scheduler, f.probe, 2);
      const unchangedAverageMs = (firstMs + secondMs) / 2;

      const forcedStarted = Date.now();
      await expect(f.service.sync("svc-1", "team-1", f.row.code_graph_id)).resolves.toMatchObject({ kind: "ok" });
      await f.service.onIdle(f.row.code_graph_id);
      const forcefulBaselineMs = Date.now() - forcedStarted;

      expect(Math.max(firstMs, secondMs)).toBeLessThan(5_000);
      expect(unchangedAverageMs).toBeLessThan(forcefulBaselineMs * 0.5);
    } finally {
      f.scheduler.stop();
      f.raw.close();
    }
  }, 20_000);
});