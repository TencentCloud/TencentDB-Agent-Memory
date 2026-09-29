import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { rename } from "node:fs/promises";

import { createCodeGraphWorker } from "./code-graph-worker.js";
import { CodeGraphHandleCloseError } from "./engines/code/index.js";
import { PreservedCodeGraphError } from "./store/code-graph-service.js";
import { createCodeGraphInstancePool, type CodeGraphInstancePool } from "./module.js";
import type { CodeGraphInstance } from "./engines/code/index.js";
import type { ISourceFetcher } from "./source-fetcher/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-codegraph-"));
  roots.push(root);
  const dir = join(root, "graph");
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "old-commit");
  writeFileSync(join(dir, ".codegraph", "index.db"), "old-index");

  const oldInstance = { projectRoot: dir, cg: {}, handler: {} } as CodeGraphInstance;
  const instances = new Map([["cg-1", oldInstance]]);
  const pause = vi.fn(async () => {});
  const resume = vi.fn();
  const instancePool: CodeGraphInstancePool = {
    get: (id) => instances.get(id),
    set: (id, instance) => { instances.set(id, instance); },
    delete: (id) => { instances.delete(id); },
    pause,
    resume,
  };

  const fetcher = {
    supportedType: "git" as const,
    validate: vi.fn(),
    sync: vi.fn<ISourceFetcher["sync"]>(),
    fetch: vi.fn<ISourceFetcher["fetch"]>(),
  };
  const openIndex = vi.fn(async (path: string) => ({ projectRoot: path, cg: {}, handler: {} }) as CodeGraphInstance);
  const indexProject = vi.fn(async (path: string) => ({ projectRoot: path, cg: {}, handler: {} }) as CodeGraphInstance);
  const syncIndex = vi.fn(async () => ({ changed: 1 }));
  const closeIndex = vi.fn();
  const getStats = vi.fn(() => ({ fileCount: 2, nodeCount: 3, edgeCount: 4 }));
  const worker = createCodeGraphWorker({
    instancePool,
    resolveFetcher: () => fetcher,
    indexOps: { openIndex, indexProject, syncIndex, closeIndex, getStats },
  });
  const ctx = {
    dir,
    repoUrl: "https://example.com/repo.git",
    branch: "main",
    codeGraphId: "cg-1",
    serviceId: "svc-1",
    teamId: "team-1",
    hadReadyIndex: true,
    preserveUntrustedCanonical: false,
    setInternalStatus: vi.fn(),
  };
  return { root, dir, oldInstance, instancePool, pause, resume, fetcher, openIndex, indexProject, syncIndex, getStats, closeIndex, worker, ctx };
}

describe("existing CodeGraph refresh", () => {
  it("preserves the old checkout, index, and pool entry when both Git operations fail", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "partially-updated");
      throw new Error("temporary Git outage");
    });
    f.fetcher.fetch.mockRejectedValue(new Error("temporary Git outage"));

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("preserves the old index when incremental indexing and fresh clone both fail", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    f.syncIndex.mockRejectedValue(new Error("indexing failed halfway"));
    f.fetcher.fetch.mockRejectedValue(new Error("clone failed"));

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);

    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("promotes a completed incremental index and reopens it at the canonical path", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);

    expect(result).toMatchObject({ commitHash: "new-commit", stats: { files: 2, nodes: 3, edges: 4 } });
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(f.openIndex).toHaveBeenCalledWith(f.dir);
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    await result.finalize?.();
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("rebuilds in isolation after an incremental error and promotes only on success", async () => {
    const f = fixture();
    f.fetcher.sync.mockRejectedValue(new Error("incremental index unavailable"));
    f.fetcher.fetch.mockImplementation(async (_url, _branch, path) => {
      mkdirSync(join(path, ".git"), { recursive: true });
      mkdirSync(join(path, ".codegraph"), { recursive: true });
      writeFileSync(join(path, ".git", "HEAD"), "fresh-commit");
      return { localPath: path, version: "fresh-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);

    expect(result.commitHash).toBe("fresh-commit");
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("fresh-commit");
    expect(existsSync(join(f.dir, ".codegraph"))).toBe(true);
    expect(f.indexProject).toHaveBeenCalledOnce();
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    await result.finalize?.();
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("can roll back a promoted candidate when metadata commit fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);
    await result.rollback?.();

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("rolls back after promotion even when the metadata store stays unavailable", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);
    f.ctx.setInternalStatus.mockImplementation(() => { throw new Error("metadata store unavailable"); });

    await expect(result.rollback?.()).resolves.toBeUndefined();
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("rolls back the previous index when reopening a promoted candidate fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    let finalOpens = 0;
    f.openIndex.mockImplementation(async (path) => {
      // First canonical open rehydrates the old index after copying. The next
      // one opens the promoted candidate and should exercise rollback.
      if (path === f.dir && finalOpens++ === 1) throw new Error("cannot open promoted index");
      return { projectRoot: path, cg: {}, handler: {} } as CodeGraphInstance;
    });

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
  });

  it("restores the original directory if the second promotion rename fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    let renames = 0;
    const renameDir = vi.fn(async (source: string, destination: string) => {
      if (++renames === 2) throw new Error("candidate rename failed");
      await rename(source, destination);
    });
    const worker = createCodeGraphWorker({
      instancePool: f.instancePool,
      resolveFetcher: () => f.fetcher,
      indexOps: {
        openIndex: f.openIndex,
        indexProject: f.indexProject,
        syncIndex: f.syncIndex,
        getStats: f.getStats,
        closeIndex: f.closeIndex,
      },
      renameDir,
    });

    await expect(worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);
    expect(renameDir).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("copies only after closing the old SQLite handle and omits transient lock files", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, ".codegraph", "codegraph.lock"), "stale lock");
    writeFileSync(join(f.dir, ".codegraph", "daemon.pid"), "123");
    writeFileSync(join(f.dir, ".codegraph", "index.log"), "old log");
    f.closeIndex.mockImplementation((instance) => {
      if (instance === f.oldInstance) {
        // Simulate a WAL checkpoint performed by CodeGraph.close().
        writeFileSync(join(f.dir, ".codegraph", "index.db"), "checkpointed");
      }
    });
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      expect(readFileSync(join(path, ".codegraph", "index.db"), "utf8")).toBe("checkpointed");
      expect(existsSync(join(path, ".codegraph", "codegraph.lock"))).toBe(false);
      expect(existsSync(join(path, ".codegraph", "daemon.pid"))).toBe(false);
      expect(existsSync(join(path, ".codegraph", "index.log"))).toBe(false);
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);

    expect(f.ctx.setInternalStatus).toHaveBeenCalledWith("copying");
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(f.pause).toHaveBeenCalledTimes(2);
    expect(f.resume).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("checkpointed");
    await result.finalize?.();
  });

  it("waits for query leases to drain before closing the old index", async () => {
    const f = fixture();
    let drain!: () => void;
    f.pause.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });

    const pending = f.worker(f.ctx);
    await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
    expect(f.ctx.setInternalStatus).toHaveBeenCalledWith("copying");
    expect(f.closeIndex).not.toHaveBeenCalledWith(f.oldInstance);
    drain();

    const result = await pending;
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    await result.finalize?.();
  });

  it("keeps a failed-to-close canonical handle reachable and never starts copying", async () => {
    const f = fixture();
    f.closeIndex.mockImplementationOnce(() => { throw new Error("SQLite close failed"); });

    await expect(f.worker(f.ctx)).rejects.toThrow("SQLite close failed");

    expect(f.instancePool.get("cg-1")).toBe(f.oldInstance);
    expect(f.fetcher.sync).not.toHaveBeenCalled();
    expect(f.fetcher.fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("does not promote when closing the serving handle fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    let canonicalCloses = 0;
    f.closeIndex.mockImplementation((instance) => {
      if (instance.projectRoot === f.dir && ++canonicalCloses === 2) {
        throw new Error("serving handle close failed");
      }
    });

    await expect(f.worker(f.ctx)).rejects.toThrow("serving handle close failed");

    expect(canonicalCloses).toBe(2);
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
  });

  it("retains a sole previous snapshot when the canonical index is missing", async () => {
    const f = fixture();
    mkdirSync(join(`${f.dir}.previous`, ".git"), { recursive: true });
    rmSync(f.dir, { recursive: true, force: true });
    f.openIndex.mockImplementation(async (path) => {
      if (!existsSync(path)) throw new Error("canonical index missing");
      return { projectRoot: path, cg: {}, handler: {} } as CodeGraphInstance;
    });

    await expect(f.worker(f.ctx)).rejects.toThrow("previous index could not be opened");

    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    expect(f.fetcher.sync).not.toHaveBeenCalled();
  });

  it("does not unlink a copied candidate if bridge cleanup left SQLite open", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    f.openIndex.mockImplementation(async (path) => {
      if (path.includes(".candidate-")) {
        throw new CodeGraphHandleCloseError("open", new Error("bad candidate"), new Error("close failed"), {}, path);
      }
      return { projectRoot: path, cg: {}, handler: {} } as CodeGraphInstance;
    });
    f.closeIndex.mockImplementation((instance) => {
      if (instance.projectRoot.includes(".candidate-")) throw new Error("SQLite still open");
    });

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readdirSync(f.root).some((name) => name.includes(".candidate-"))).toBe(true);
  });
});

describe("initial CodeGraph build", () => {
  function initialFixture() {
    const f = fixture();
    f.ctx.hadReadyIndex = false;
    f.instancePool.delete("cg-1");
    f.fetcher.fetch.mockImplementation(async (_url, _branch, path) => {
      mkdirSync(join(path, ".git"), { recursive: true });
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });
    return f;
  }

  it("closes the index after getStats fails and can retry the initial build", async () => {
    const f = initialFixture();
    const firstInstance = { projectRoot: f.dir, cg: {}, handler: {} } as CodeGraphInstance;
    f.indexProject.mockResolvedValueOnce(firstInstance);
    f.getStats.mockImplementationOnce(() => { throw new Error("stats unavailable"); });

    await expect(f.worker(f.ctx)).rejects.toThrow("stats unavailable");
    expect(f.closeIndex).toHaveBeenCalledWith(firstInstance);
    expect(f.instancePool.get("cg-1")).toBeUndefined();
    expect(existsSync(f.dir)).toBe(false);

    const result = await f.worker(f.ctx);
    expect(result.stats).toEqual({ files: 2, nodes: 3, edges: 4 });
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
  });

  it("keeps the checkout intact if close fails, then closes it before retry", async () => {
    const f = initialFixture();
    const firstInstance = { projectRoot: f.dir, cg: {}, handler: {} } as CodeGraphInstance;
    f.indexProject.mockResolvedValueOnce(firstInstance);
    f.getStats.mockImplementationOnce(() => { throw new Error("stats unavailable"); });
    f.closeIndex.mockImplementationOnce(() => { throw new Error("SQLite close failed"); });

    await expect(f.worker(f.ctx)).rejects.toThrow("CodeGraph initial build and index close both failed");
    expect(f.instancePool.get("cg-1")).toBe(firstInstance);
    expect(existsSync(f.dir)).toBe(true);

    f.closeIndex.mockImplementation((instance) => {
      if (instance === firstInstance) expect(existsSync(f.dir)).toBe(true);
    });
    await expect(f.worker(f.ctx)).resolves.toMatchObject({ commitHash: "new-commit" });
    expect(f.closeIndex).toHaveBeenCalledWith(firstInstance);
    expect(f.instancePool.get("cg-1")).not.toBe(firstInstance);
  });

  it("retains a bridge handle that could not close after an initial indexing error", async () => {
    const f = initialFixture();
    const leaked = { projectRoot: f.dir, cg: {}, handler: null } as CodeGraphInstance;
    f.indexProject.mockRejectedValueOnce(new CodeGraphHandleCloseError(
      "indexing", new Error("index failed"), new Error("close failed"), leaked.cg, f.dir,
    ));

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(CodeGraphHandleCloseError);
    expect(f.instancePool.get("cg-1")?.cg).toBe(leaked.cg);
    expect(existsSync(f.dir)).toBe(true);

    await expect(f.worker(f.ctx)).resolves.toMatchObject({ commitHash: "new-commit" });
    expect(f.closeIndex).toHaveBeenCalledWith(expect.objectContaining({ cg: leaked.cg }));
  });

  it("closes and removes a built index when metadata commit requires rollback", async () => {
    const f = initialFixture();
    const instance = { projectRoot: f.dir, cg: {}, handler: {} } as CodeGraphInstance;
    f.indexProject.mockResolvedValueOnce(instance);

    const result = await f.worker(f.ctx);
    expect(f.instancePool.get("cg-1")).toBe(instance);
    f.ctx.setInternalStatus.mockImplementation(() => { throw new Error("metadata store unavailable"); });

    await expect(result.rollback?.()).resolves.toBeUndefined();
    expect(f.closeIndex).toHaveBeenCalledWith(instance);
    expect(f.instancePool.get("cg-1")).toBeUndefined();
    expect(existsSync(f.dir)).toBe(false);

    f.ctx.setInternalStatus.mockImplementation(() => {});
    await expect(f.worker(f.ctx)).resolves.toMatchObject({ commitHash: "new-commit" });
  });

  it("drains and closes a stale initial-build handle before removing its directory", async () => {
    const f = initialFixture();
    f.instancePool.set("cg-1", f.oldInstance);
    f.closeIndex.mockImplementation((instance) => {
      if (instance === f.oldInstance) {
        expect(existsSync(join(f.dir, ".codegraph", "index.db"))).toBe(true);
      }
    });
    f.fetcher.fetch.mockImplementation(async (_url, _branch, path) => {
      expect(existsSync(join(path, ".codegraph", "index.db"))).toBe(false);
      mkdirSync(join(path, ".git"), { recursive: true });
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    await f.worker(f.ctx);

    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(f.instancePool.get("cg-1")).not.toBe(f.oldInstance);
  });
});

describe("failed CodeGraph retry with an untrusted canonical snapshot", () => {
  function suspectFixture() {
    const f = fixture();
    f.ctx.hadReadyIndex = false;
    f.ctx.preserveUntrustedCanonical = true;
    f.fetcher.fetch.mockImplementation(async (_url, _branch, path) => {
      // A failed row's old snapshot must remain intact throughout indexing.
      expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
      mkdirSync(join(path, ".git"), { recursive: true });
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });
    return f;
  }

  it("builds a fresh candidate, preserves suspect until commit, then finalizes", async () => {
    const f = suspectFixture();

    const result = await f.worker(f.ctx);

    expect(result.commitHash).toBe("new-commit");
    expect(f.fetcher.sync).not.toHaveBeenCalled();
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(readFileSync(join(`${f.dir}.suspect`, ".git", "HEAD"), "utf8")).toBe("old-commit");
    await result.finalize?.();
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
  });

  it("restores suspect after a failed metadata commit without exposing it in the pool", async () => {
    const f = suspectFixture();

    const result = await f.worker(f.ctx);
    await result.rollback?.();

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.instancePool.get("cg-1")).toBeUndefined();
  });

  it("keeps the only canonical snapshot when the fresh candidate fails", async () => {
    const f = suspectFixture();
    f.fetcher.fetch.mockRejectedValue(new Error("Git unavailable"));

    await expect(f.worker(f.ctx)).rejects.toThrow("Git unavailable");

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
    expect(f.instancePool.get("cg-1")).toBeUndefined();
  });

  it("restores suspect when promoting the candidate fails", async () => {
    const f = suspectFixture();
    let renames = 0;
    const renameDir = vi.fn(async (source: string, destination: string) => {
      if (++renames === 2) throw new Error("candidate promotion failed");
      await rename(source, destination);
    });
    const worker = createCodeGraphWorker({
      instancePool: f.instancePool,
      resolveFetcher: () => f.fetcher,
      indexOps: {
        openIndex: f.openIndex, indexProject: f.indexProject, syncIndex: f.syncIndex,
        getStats: f.getStats, closeIndex: f.closeIndex,
      },
      renameDir,
    });

    await expect(worker(f.ctx)).rejects.toThrow("candidate promotion failed");

    expect(renameDir).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(existsSync(`${f.dir}.suspect`)).toBe(false);
  });

  it("retains a candidate whose leaked SQLite handle cannot be closed", async () => {
    const f = suspectFixture();
    const leaked = { projectRoot: "", cg: {}, handler: null } as CodeGraphInstance;
    f.indexProject.mockImplementation(async (path) => {
      leaked.projectRoot = path;
      throw new CodeGraphHandleCloseError("indexing", new Error("parse failed"), new Error("close failed"), leaked.cg, path);
    });
    f.closeIndex.mockImplementation((instance) => {
      if (instance.projectRoot !== f.dir) throw new Error("SQLite close still failed");
    });

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(CodeGraphHandleCloseError);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readdirSync(f.root).some((name) => name.includes(".candidate-"))).toBe(true);
  });

  it("blocks a retry while a candidate handle remains open, then closes and cleans it", async () => {
    const f = suspectFixture();
    let firstCandidate = "";
    let firstCloseAttempts = 0;
    f.indexProject.mockImplementation(async (path) => {
      if (!firstCandidate) firstCandidate = path;
      return { projectRoot: path, cg: {}, handler: {} } as CodeGraphInstance;
    });
    f.closeIndex.mockImplementation((instance) => {
      if (instance.projectRoot === firstCandidate && ++firstCloseAttempts <= 3) {
        throw new Error("candidate SQLite close failed");
      }
    });

    await expect(f.worker(f.ctx)).rejects.toThrow("candidate SQLite close failed");
    expect(existsSync(firstCandidate)).toBe(true);
    expect(f.fetcher.fetch).toHaveBeenCalledOnce();

    await expect(f.worker(f.ctx)).rejects.toThrow("candidate SQLite close failed");
    expect(f.fetcher.fetch).toHaveBeenCalledOnce();
    expect(existsSync(firstCandidate)).toBe(true);

    const result = await f.worker(f.ctx);
    expect(firstCloseAttempts).toBe(4);
    expect(existsSync(firstCandidate)).toBe(false);
    expect(f.fetcher.fetch).toHaveBeenCalledTimes(2);
    await result.finalize?.();
  });

  it("prevents delete from taking the production pool gate while a candidate remains open", async () => {
    const f = suspectFixture();
    let candidateDir = "";
    let firstCandidate = "";
    let allowClose = false;
    f.indexProject.mockImplementation(async (path) => {
      candidateDir = path;
      if (!firstCandidate) firstCandidate = path;
      return { projectRoot: path, cg: {}, handler: {} } as CodeGraphInstance;
    });
    f.closeIndex.mockImplementation((instance) => {
      if (instance.projectRoot === candidateDir && !allowClose) throw new Error("candidate close failed");
    });
    const pool = createCodeGraphInstancePool({ openIndex: f.openIndex, closeIndex: f.closeIndex });
    pool.set("cg-1", f.oldInstance);
    const worker = createCodeGraphWorker({
      instancePool: pool,
      resolveFetcher: () => f.fetcher,
      indexOps: {
        openIndex: f.openIndex, indexProject: f.indexProject, syncIndex: f.syncIndex,
        getStats: f.getStats, closeIndex: f.closeIndex,
      },
    });

    await expect(worker(f.ctx)).rejects.toThrow("candidate close failed");
    expect(existsSync(candidateDir)).toBe(true);
    // The delete path must acquire tryPause before removing any directory.
    expect(() => pool.tryPause("cg-1")).toThrow("candidate close failed");
    expect(existsSync(candidateDir)).toBe(true);

    allowClose = true;
    expect(pool.tryPause("cg-1")).toBe(true);
    pool.resume("cg-1");
    await worker(f.ctx);
    expect(existsSync(firstCandidate)).toBe(false);
  });
});
