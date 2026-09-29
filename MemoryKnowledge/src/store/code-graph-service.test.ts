import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeGraphService, PreservedCodeGraphError } from "./code-graph-service.js";
import { createCodeGraphRoutes } from "../routes/code-graph.js";
import { createCodeGraphInstancePool, createCodeGraphInstanceReleaser, type CodeGraphInstancePool } from "../module.js";
import type { CodeGraphInstance } from "../engines/code/index.js";
import type { CodeGraphRow, IKnowledgeStore } from "./types.js";

const removalProbe = vi.hoisted(() => ({
  failCanonicalOnce: false,
  blockCanonical: null as Promise<void> | null,
  canonicalStarted: null as (() => void) | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (removalProbe.blockCanonical && String(args[0]).endsWith("/cg-1")) {
        removalProbe.canonicalStarted?.();
        await removalProbe.blockCanonical;
      }
      if (removalProbe.failCanonicalOnce && String(args[0]).endsWith("/cg-1")) {
        removalProbe.failCanonicalOnce = false;
        throw new Error("disk removal failed");
      }
      return actual.rm(...args);
    },
  };
});
afterEach(() => {
  removalProbe.failCanonicalOnce = false;
  removalProbe.blockCanonical = null;
  removalProbe.canonicalStarted = null;
  vi.unstubAllGlobals();
});

function fixture(lastSyncAt: string | null) {
  const row: CodeGraphRow = {
    code_graph_id: "cg-1", service_id: "svc-1", team_id: "team-1",
    repo_name: "repo", repo_url: "https://example.com/repo.git", branch: "main",
    commit_hash: lastSyncAt ? "old-commit" : null,
    owner_user_id: null, user_id: null, agent_id: null, task_id: null,
    visibility: "private", status: lastSyncAt ? "ready" : "pending",
    internal_status: null, sync_error: null,
    stats_json: lastSyncAt ? '{"files":2,"nodes":3,"edges":4}' : null,
    service_url: null, summary: "Existing summary",
    auto_sync_probe_error: null, auto_sync_probe_at: null, version: 1,
    has_last_good: lastSyncAt !== null,
    last_sync_at: lastSyncAt, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", deleted_at: null,
  };
  const audits: Array<{ action: string; version: number }> = [];
  const store = {
    createCodeGraph: () => ({ row, existed: false }),
    getCodeGraph: () => row.deleted_at ? null : row,
    getCodeGraphById: () => row.deleted_at ? null : row,
    deleteCodeGraph: vi.fn(() => {
      if (row.deleted_at) return false;
      row.deleted_at = new Date().toISOString();
      return true;
    }),
    updateCodeGraphStatus: (_serviceId: string, _id: string, patch: Partial<CodeGraphRow>) => { Object.assign(row, patch); },
    updateCodeGraphProbeDiagnostic: (
      _serviceId: string, _teamId: string, _id: string, version: number, error: string | null,
    ) => {
      if (row.status !== "ready" || !row.has_last_good || row.version !== version) return false;
      row.auto_sync_probe_error = error;
      row.auto_sync_probe_at = error === null ? null : new Date().toISOString();
      return true;
    },
    tryAdmitCodeGraphSync: (_serviceId: string, _teamId: string, _id: string, version: number) => {
      if ((row.status !== "ready" && row.status !== "failed") || row.version !== version) return false;
      Object.assign(row, {
        status: "pending", internal_status: null, sync_error: null, version: version + 1,
      });
      return true;
    },
    appendCodeGraphAudit: (entry: { action: string; version: number }) => { audits.push(entry); },
    listSyncedCodeGraphs: () => row.status === "ready" ? [{
      code_graph_id: row.code_graph_id, service_id: row.service_id, team_id: row.team_id,
    }] : [],
  } as unknown as IKnowledgeStore;
  return { row, store, audits };
}

describe("CodeGraphService refresh failure", () => {
  it("keeps a preserved last-good build ready and eligible for auto-sync", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });

    expect((await service.sync("svc-1", "team-1", "cg-1")).kind).toBe("ok");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(row.sync_error).toBe("Git unavailable");
    expect(row.commit_hash).toBe("old-commit");
    expect(row.stats_json).toBe('{"files":2,"nodes":3,"edges":4}');
    expect(row.last_sync_at).toBe("2026-01-01T00:00:00Z");
    expect(store.listSyncedCodeGraphs()).toHaveLength(1);

    const previousInstance = {
      projectRoot: "/unused/svc-1/team-1/cg-1", cg: {},
      handler: { execute: async () => ({ content: [{ text: "old index still answers" }], isError: false }) },
    };
    const pool = {
      get: () => previousInstance, set: () => {}, delete: () => {},
    } as CodeGraphInstancePool;
    const routes = createCodeGraphRoutes({ cgService: service, instancePool: pool, publicBaseUrl: "" });
    const response = await routes.request("/status", {
      method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
      body: JSON.stringify({ code_graph_id: "cg-1" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.text).toBe("old index still answers");
  });

  it("reports preserved refresh failure distinctly to audit and Panel", async () => {
    const { row, store, audits } = fixture("2026-01-01T00:00:00Z");
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", send);
    const service = new CodeGraphService({
      store, dataRoot: "/unused", callbackConfig: { tmcCallbackUrl: "https://example.com" },
      worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(audits.map((entry) => entry.action)).toEqual(["ingest", "refresh_failed"]);
    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse((send.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload).toMatchObject({ status: "ready", event: "refresh_failed", sync_error: "Git unavailable" });
  });

  it("keeps an initial build failure unavailable", async () => {
    const { row, store } = fixture(null);
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new Error("Git unavailable"); },
    });

    service.create({ service_id: "svc-1", team_id: "team-1", repo_url: row.repo_url, branch: "main" });
    await service.onIdle("cg-1");

    expect(row.status).toBe("failed");
    expect(row.sync_error).toBe("Git unavailable");
    expect(store.listSyncedCodeGraphs()).toHaveLength(0);
  });

  it("does not infer a last-good index from a first-build preservation error", async () => {
    const { row, store } = fixture(null);
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new PreservedCodeGraphError(new Error("No committed build")); },
    });

    service.create({ service_id: "svc-1", team_id: "team-1", repo_url: row.repo_url, branch: "main" });
    await service.onIdle("cg-1");

    expect(row.status).toBe("failed");
  });

  it("uses the admitted ready state even when legacy metadata has no last-sync timestamp", async () => {
    const { row, store } = fixture(null);
    row.status = "ready";
    row.commit_hash = "old-commit";
    row.has_last_good = true;
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("old-commit");
  });

  it("does not claim readiness when a refresh cannot preserve the previous index", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new Error("rollback failed"); },
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("failed");
    expect(row.sync_error).toBe("rollback failed");
  });

  it("removes the retired snapshot only after the new metadata is committed", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const observedStatuses: string[] = [];
    const service = new CodeGraphService({
      store, dataRoot: "/unused",
      worker: async () => ({
        commitHash: "new-commit", stats: { files: 4, nodes: 5, edges: 6 },
        finalize: () => { observedStatuses.push(row.status); },
      }),
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(observedStatuses).toEqual(["ready"]);
    expect(row.commit_hash).toBe("new-commit");
  });

  it("rolls back a promoted index if the metadata commit fails", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const update = store.updateCodeGraphStatus.bind(store);
    let commitFailed = false;
    store.updateCodeGraphStatus = (serviceId, id, patch) => {
      if (patch.commit_hash === "new-commit" && !commitFailed) {
        commitFailed = true;
        throw new Error("SQLite write failed");
      }
      update(serviceId, id, patch);
    };
    let rolledBack = false;
    const service = new CodeGraphService({
      store, dataRoot: "/unused",
      worker: async () => ({
        commitHash: "new-commit", stats: { files: 4, nodes: 5, edges: 6 },
        rollback: async () => { rolledBack = true; },
      }),
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(rolledBack).toBe(true);
    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("old-commit");
    expect(row.sync_error).toBe("SQLite write failed");
  });

  it("keeps the committed index ready when a post-build summary hook fails", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const update = store.updateCodeGraphStatus.bind(store);
    store.updateCodeGraphStatus = (serviceId, id, patch) => {
      if (patch.summary !== undefined) throw new Error("summary write failed");
      update(serviceId, id, patch);
    };
    const service = new CodeGraphService({
      store, dataRoot: "/unused",
      callbackConfig: { tmcCallbackUrl: "http://example.invalid" },
      worker: async () => ({ commitHash: "new-commit", stats: { files: 4, nodes: 5, edges: 6 } }),
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("new-commit");
  });

  it("removes orphaned candidate directories when an asset is deleted", async () => {
    const { store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-candidate-delete-"));
    const candidate = join(root, "svc-1", "team-1", ".cg-1.candidate-1234");
    mkdirSync(candidate, { recursive: true });
    try {
      const service = new CodeGraphService({ store, dataRoot: root, worker: async () => ({}) });
      expect(await service.delete("svc-1", "team-1", "cg-1")).toBe(true);
      await service.onIdle("cg-1");
      expect(existsSync(candidate)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects delete while a query holds an index lease without deleting later", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-query-"));
    const dir = join(root, "svc-1", "team-1", row.code_graph_id);
    mkdirSync(dir, { recursive: true });
    let queryStarted!: () => void;
    let finishQuery!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { finishQuery = resolve; });
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({ openIndex: vi.fn(), closeIndex });
    pool.set(row.code_graph_id, {
      projectRoot: dir, cg: {}, handler: { execute: async () => {
        queryStarted();
        await blocked;
        return { content: [{ text: "query completed" }], isError: false };
      } },
    });
    const service = new CodeGraphService({
      store, dataRoot: root, worker: async () => ({}),
      releaseInstance: createCodeGraphInstanceReleaser(pool, closeIndex),
    });
    try {
      const routes = createCodeGraphRoutes({ cgService: service, instancePool: pool, publicBaseUrl: "" });
      const query = routes.request("/status", {
        method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
        body: JSON.stringify({ code_graph_id: row.code_graph_id }),
      });
      await started;
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(false);
      expect(closeIndex).not.toHaveBeenCalled();
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);

      finishQuery();
      expect((await query).status).toBe(200);
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(true);
      await service.onIdle(row.code_graph_id);
      expect(closeIndex).toHaveBeenCalledOnce();
      expect(existsSync(dir)).toBe(false);
    } finally {
      finishQuery();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects delete during a lazy index load without deleting later", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-load-"));
    const dir = join(root, "svc-1", "team-1", row.code_graph_id);
    mkdirSync(dir, { recursive: true });
    let loadStarted!: () => void;
    let finishLoad!: (instance: CodeGraphInstance) => void;
    const started = new Promise<void>((resolve) => { loadStarted = resolve; });
    const opening = new Promise<CodeGraphInstance>((resolve) => { finishLoad = resolve; });
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({
      openIndex: vi.fn(async () => { loadStarted(); return opening; }), closeIndex,
    });
    const service = new CodeGraphService({
      store, dataRoot: root, worker: async () => ({}),
      releaseInstance: createCodeGraphInstanceReleaser(pool, closeIndex),
    });
    try {
      const routes = createCodeGraphRoutes({ cgService: service, instancePool: pool, publicBaseUrl: "" });
      const query = routes.request("/status", {
        method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
        body: JSON.stringify({ code_graph_id: row.code_graph_id }),
      });
      await started;
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(false);
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
      finishLoad({ projectRoot: dir, cg: {}, handler: { execute: async () => ({ content: [{ text: "ok" }], isError: false }) } });
      expect((await query).status).toBe(200);
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(true);
      await service.onIdle(row.code_graph_id);
      expect(closeIndex).toHaveBeenCalledOnce();
      expect(existsSync(dir)).toBe(false);
    } finally {
      finishLoad({ projectRoot: dir, cg: {}, handler: { execute: async () => ({ content: [{ text: "ok" }], isError: false }) } });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the last-good directory and reports failure when metadata deletion fails", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-failure-"));
    const dir = join(root, "svc-1", "team-1", row.code_graph_id);
    mkdirSync(dir, { recursive: true });
    const resume = vi.fn();
    store.deleteCodeGraph = vi.fn(() => { throw new Error("SQLite unavailable"); });
    const service = new CodeGraphService({
      store, dataRoot: root, worker: async () => ({}),
      releaseInstance: async () => resume,
    });
    try {
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(false);
      expect(existsSync(dir)).toBe(true);
      expect(row.status).toBe("ready");
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not commit a delete after index close has exhausted the request deadline", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-deadline-"));
    const dir = join(root, "svc-1", "team-1", row.code_graph_id);
    mkdirSync(dir, { recursive: true });
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resume = vi.fn();
    const releaseInstance = vi.fn(async () => {
      now = 12_000;
      return resume;
    });
    const service = new CodeGraphService({
      store, dataRoot: root, worker: async () => ({}), releaseInstance,
    });
    try {
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(false);
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
      expect(resume).toHaveBeenCalledOnce();

      // A fresh caller may retry; the earlier timed-out attempt cannot
      // commit a hard delete after its response deadline.
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(true);
      await service.onIdle(row.code_graph_id);
      expect(store.deleteCodeGraph).toHaveBeenCalledOnce();
      expect(existsSync(dir)).toBe(false);
    } finally {
      clock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries file cleanup only for a deleted asset recorded by this service", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-retry-"));
    const dir = join(root, "svc-1", "team-1", row.code_graph_id);
    mkdirSync(dir, { recursive: true });
    const service = new CodeGraphService({ store, dataRoot: root, worker: async () => ({}) });
    const routes = createCodeGraphRoutes({ cgService: service, instancePool: {} as CodeGraphInstancePool, publicBaseUrl: "" });
    const request = () => routes.request("/delete", {
      method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
      body: JSON.stringify({ code_graph_ids: [row.code_graph_id] }),
    });
    try {
      removalProbe.failCanonicalOnce = true;
      const first = await request();
      expect((await first.json()).data.deleted_ids).toEqual([row.code_graph_id]);
      await service.onIdle(row.code_graph_id);
      expect(store.getCodeGraphById("svc-1", row.code_graph_id)).toBeNull();
      expect(service.hasPendingCleanup("svc-1", row.code_graph_id)).toBe(true);
      expect(existsSync(dir)).toBe(true);

      const second = await request();
      expect((await second.json()).data.deleted_ids).toEqual([row.code_graph_id]);
      await service.onIdle(row.code_graph_id);
      expect(service.hasPendingCleanup("svc-1", row.code_graph_id)).toBe(false);
      expect(existsSync(dir)).toBe(false);
      const third = await request();
      expect((await third.json()).data.failed).toEqual([{ id: row.code_graph_id, reason: "not found" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("confirms metadata deletion before a slow directory removal finishes", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-slow-files-"));
    const dir = join(root, "svc-1", "team-1", row.code_graph_id);
    mkdirSync(dir, { recursive: true });
    let startRemoval!: () => void;
    let finishRemoval!: () => void;
    const started = new Promise<void>((resolve) => { startRemoval = resolve; });
    removalProbe.blockCanonical = new Promise<void>((resolve) => { finishRemoval = resolve; });
    removalProbe.canonicalStarted = startRemoval;
    const service = new CodeGraphService({ store, dataRoot: root, worker: async () => ({}) });
    try {
      const deleting = service.delete("svc-1", "team-1", row.code_graph_id);
      await started;
      expect(await deleting).toBe(true);
      expect(store.getCodeGraphById("svc-1", row.code_graph_id)).toBeNull();
      expect(existsSync(dir)).toBe(true);
      expect(service.hasPendingCleanup("svc-1", row.code_graph_id)).toBe(true);
      finishRemoval();
      await service.onIdle(row.code_graph_id);
      expect(existsSync(dir)).toBe(false);
      expect(service.hasPendingCleanup("svc-1", row.code_graph_id)).toBe(false);
    } finally {
      finishRemoval();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects deletion during a running build without scheduling a late hard delete", async () => {
    const { row, store } = fixture(null);
    const root = mkdtempSync(join(tmpdir(), "knowledge-delete-building-"));
    const events: string[] = [];
    const hardDelete = store.deleteCodeGraph.bind(store);
    store.deleteCodeGraph = vi.fn((serviceId, teamId, id) => {
      events.push("metadata deleted");
      return hardDelete(serviceId, teamId, id);
    });
    let workerStarted!: () => void;
    let finishWorker!: () => void;
    const started = new Promise<void>((resolve) => { workerStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { finishWorker = resolve; });
    const service = new CodeGraphService({
      store, dataRoot: root,
      worker: async (ctx) => {
        workerStarted();
        await blocked;
        mkdirSync(ctx.dir, { recursive: true });
        events.push("worker wrote directory");
        return { commitHash: "built" };
      },
    });
    try {
      service.create({ service_id: "svc-1", team_id: "team-1", repo_url: row.repo_url, branch: "main" });
      await started;
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(false);
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      finishWorker();
      await service.onIdle(row.code_graph_id);
      expect(events).toEqual(["worker wrote directory"]);
      expect(store.getCodeGraphById("svc-1", row.code_graph_id)?.status).toBe("ready");
      expect(existsSync(service.dirFor("svc-1", "team-1", row.code_graph_id))).toBe(true);
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(true);
      await service.onIdle(row.code_graph_id);
      expect(events).toEqual(["worker wrote directory", "metadata deleted"]);
      expect(existsSync(service.dirFor("svc-1", "team-1", row.code_graph_id))).toBe(false);
    } finally {
      finishWorker();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enqueues an admitted sync before a concurrent delete can inspect queue state", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-sync-delete-"));
    let workerStarted!: () => void;
    let finishWorker!: () => void;
    const started = new Promise<void>((resolve) => { workerStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { finishWorker = resolve; });
    const worker = vi.fn(async () => {
      workerStarted();
      await blocked;
      return { commitHash: "new-commit" };
    });
    const service = new CodeGraphService({ store, dataRoot: root, worker });
    try {
      const syncing = service.sync("svc-1", "team-1", row.code_graph_id);
      await started;
      expect((await syncing).kind).toBe("ok");
      const routes = createCodeGraphRoutes({ cgService: service, instancePool: {} as CodeGraphInstancePool, publicBaseUrl: "" });
      const response = await routes.request("/delete", {
        method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
        body: JSON.stringify({ code_graph_ids: [row.code_graph_id] }),
      });
      expect((await response.json()).data.failed).toEqual([{ id: row.code_graph_id, reason: "busy" }]);
      expect((await service.sync("svc-1", "team-1", row.code_graph_id)).kind).toBe("busy");
      expect(store.deleteCodeGraph).not.toHaveBeenCalled();
      finishWorker();
      await service.onIdle(row.code_graph_id);
      expect(store.getCodeGraphById("svc-1", row.code_graph_id)?.status).toBe("ready");
      expect(await service.delete("svc-1", "team-1", row.code_graph_id)).toBe(true);
      expect(worker).toHaveBeenCalledOnce();
    } finally {
      finishWorker();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a failed build if the first processing status write fails", async () => {
    const { row, store } = fixture(null);
    const originalUpdate = store.updateCodeGraphStatus.bind(store);
    let failOnce = true;
    store.updateCodeGraphStatus = (serviceId, id, patch) => {
      if (patch.status === "processing" && failOnce) {
        failOnce = false;
        throw new Error("SQLite status write failed");
      }
      originalUpdate(serviceId, id, patch);
    };
    const worker = vi.fn(async () => ({}));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker });
    service.create({ service_id: "svc-1", team_id: "team-1", repo_url: row.repo_url, branch: "main" });
    await service.onIdle("cg-1");
    expect(worker).not.toHaveBeenCalled();
    expect(row.status).toBe("failed");
    expect(row.sync_error).toBe("SQLite status write failed");
  });

  it("returns unchanged before admission and leaves the last-good build untouched", async () => {
    const { row, store, audits } = fixture("2026-01-01T00:00:00Z");
    const admit = vi.spyOn(store, "tryAdmitCodeGraphSync");
    const updateStatus = vi.spyOn(store, "updateCodeGraphStatus");
    const releaseInstance = vi.fn();
    const worker = vi.fn(async () => ({ commitHash: "unexpected" }));
    const versionProbe = vi.fn(async () => ({ kind: "unchanged" as const, revision: "a".repeat(40) }));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe, releaseInstance });

    const before = { ...row };
    await expect(service.syncIfChanged("svc-1", "team-1", row.code_graph_id)).resolves.toEqual({
      kind: "unchanged", revision: "a".repeat(40),
    });

    expect(row).toEqual(before);
    expect(versionProbe).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(releaseInstance).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("keeps a last-good graph ready when the automatic version probe fails", async () => {
    const { row, store, audits } = fixture("2026-01-01T00:00:00Z");
    const worker = vi.fn(async () => ({ commitHash: "unexpected" }));
    const versionProbe = vi.fn(async () => ({
      kind: "failed" as const, code: "timeout" as const, retryable: true as const, message: "probe timed out",
    }));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    await expect(service.syncIfChanged("svc-1", "team-1", row.code_graph_id)).resolves.toEqual({
      kind: "probe_failed", code: "timeout", retryable: true, message: "probe timed out",
    });

    expect(row.status).toBe("ready");
    expect(row.sync_error).toBeNull();
    expect(row.auto_sync_probe_error).toBe("[timeout] probe timed out");
    expect(row.auto_sync_probe_at).not.toBeNull();
    expect(row.last_sync_at).toBe("2026-01-01T00:00:00Z");
    expect(worker).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("persists unexpected automatic probe exceptions as independent diagnostics", async () => {
    const { row, store, audits } = fixture("2026-01-01T00:00:00Z");
    const worker = vi.fn(async () => ({ commitHash: "unexpected" }));
    const versionProbe = vi.fn(async () => { throw new Error("probe exploded"); });
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    await expect(service.syncIfChanged("svc-1", "team-1", row.code_graph_id)).resolves.toEqual({
      kind: "probe_failed", code: "remote_error", retryable: true, message: "probe exploded",
    });

    expect(row.status).toBe("ready");
    expect(row.sync_error).toBeNull();
    expect(row.auto_sync_probe_error).toBe("[remote_error] probe exploded");
    expect(row.auto_sync_probe_at).not.toBeNull();
    expect(worker).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it("admits one automatic refresh when the remote revision changed", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const worker = vi.fn(async () => ({ commitHash: "b".repeat(40) }));
    const versionProbe = vi.fn(async () => ({
      kind: "changed" as const, localRevision: "a".repeat(40), remoteRevision: "b".repeat(40),
    }));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    expect((await service.syncIfChanged("svc-1", "team-1", row.code_graph_id)).kind).toBe("ok");
    await service.onIdle(row.code_graph_id);

    expect(worker).toHaveBeenCalledOnce();
    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("b".repeat(40));
  });

  it("keeps a probe diagnostic through admission and clears it after a ready refresh", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    row.auto_sync_probe_error = "[timeout] previous probe timed out";
    row.auto_sync_probe_at = "2026-01-02T00:00:00Z";
    let releaseWorker!: () => void;
    let workerStarted!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const started = new Promise<void>((resolve) => { workerStarted = resolve; });
    const worker = vi.fn(async () => {
      workerStarted();
      await workerGate;
      return { commitHash: "b".repeat(40) };
    });
    const versionProbe = vi.fn(async () => ({
      kind: "changed" as const, localRevision: "a".repeat(40), remoteRevision: "b".repeat(40),
    }));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    await expect(service.syncIfChanged("svc-1", "team-1", row.code_graph_id)).resolves.toMatchObject({ kind: "ok" });
    await started;
    expect(row.status).toBe("processing");
    expect(row.auto_sync_probe_error).toBe("[timeout] previous probe timed out");
    expect(row.auto_sync_probe_at).toBe("2026-01-02T00:00:00Z");

    releaseWorker();
    await service.onIdle(row.code_graph_id);

    expect(row.status).toBe("ready");
    expect(row.auto_sync_probe_error).toBeNull();
    expect(row.auto_sync_probe_at).toBeNull();
  });

  it("falls back to the existing refresh path when the local checkout or index is unverifiable", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const worker = vi.fn(async () => ({ commitHash: "c".repeat(40) }));
    const versionProbe = vi.fn(async () => ({
      kind: "refresh_required" as const, reason: "canonical checkout or index is not verifiable",
    }));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    expect((await service.syncIfChanged("svc-1", "team-1", row.code_graph_id)).kind).toBe("ok");
    await service.onIdle(row.code_graph_id);

    expect(worker).toHaveBeenCalledOnce();
    expect(row.commit_hash).toBe("c".repeat(40));
  });

  it("lets a concurrent manual sync win admission while an equality probe is pending", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    let finishProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { finishProbe = resolve; });
    let finishWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { finishWorker = resolve; });
    const worker = vi.fn(async () => {
      await workerGate;
      return { commitHash: "a".repeat(40) };
    });
    const versionProbe = vi.fn(async () => {
      await probeGate;
      return { kind: "unchanged" as const, revision: "a".repeat(40) };
    });
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    const automatic = service.syncIfChanged("svc-1", "team-1", row.code_graph_id);
    await Promise.resolve();
    expect((await service.sync("svc-1", "team-1", row.code_graph_id)).kind).toBe("ok");
    finishProbe();
    await expect(automatic).resolves.toMatchObject({ kind: "busy" });

    finishWorker();
    await service.onIdle(row.code_graph_id);
    expect(worker).toHaveBeenCalledOnce();
  });

  it("keeps explicit sync forceful even when the probe would report unchanged", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const worker = vi.fn(async () => ({ commitHash: "a".repeat(40) }));
    const versionProbe = vi.fn(async () => ({ kind: "unchanged" as const, revision: "a".repeat(40) }));
    const service = new CodeGraphService({ store, dataRoot: "/unused", worker, versionProbe });

    expect((await service.sync("svc-1", "team-1", row.code_graph_id)).kind).toBe("ok");
    await service.onIdle(row.code_graph_id);

    expect(versionProbe).not.toHaveBeenCalled();
    expect(worker).toHaveBeenCalledOnce();
  });
});
