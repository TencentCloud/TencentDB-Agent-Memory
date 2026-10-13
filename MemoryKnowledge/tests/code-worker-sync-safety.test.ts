import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createKnowledgeModule } from "../src/module.js";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/client.js";

const { mockFetch, mockSync, mockOpenIndex, mockIndexProject, mockSyncIndex, mockCloseIndex, mockGetStats } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockSync: vi.fn(),
  mockOpenIndex: vi.fn(),
  mockIndexProject: vi.fn(),
  mockSyncIndex: vi.fn(),
  mockCloseIndex: vi.fn(),
  mockGetStats: vi.fn()
}));

vi.mock("../src/source-fetcher/index.js", () => ({
  SourceFetcherRegistry: class {
    resolve() {
      return { fetch: mockFetch, sync: mockSync };
    }
  }
}));

vi.mock("../src/engines/code/index.js", () => ({
  openIndex: mockOpenIndex,
  indexProject: mockIndexProject,
  syncIndex: mockSyncIndex,
  closeIndex: mockCloseIndex,
  getStats: mockGetStats
}));


describe("Code Worker Sync Safety", () => {
  let workDir: string;
  let dbInstance: { db: any, raw: any };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "code-worker-"));
    dbInstance = createDb({ path: ":memory:" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { dbInstance.raw.close(); } catch {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  it("rejects caller URL credentials before provider transformation or mutation", async () => {
    const mod = createKnowledgeModule({ dataDir: workDir, db: dbInstance.db, llmConfig: {} as any });
    const workerCtx = {
      dir: join(workDir, "repo"), repoUrl: "https://user:synthetic-password@test.local/repo.git",
      branch: "main", codeGraphId: "cg-1", serviceId: "synthetic-service",
      setInternalStatus: vi.fn(), setPageProgress: vi.fn(), taskContext: {},
    } as any;
    await expect(mod.cgService["worker"](workerCtx)).rejects.toThrow("Repository URL credentials are not allowed");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockOpenIndex).not.toHaveBeenCalled();
    expect(existsSync(workerCtx.dir)).toBe(false);
  });

  it("failed sync preserves existing files/index and fetch is not called as fallback", async () => {
    const mod = createKnowledgeModule({
      dataDir: workDir,
      db: dbInstance.db,
      llmConfig: {} as any
    });

    const repoDir = join(workDir, "repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const checkoutFile = join(repoDir, "test.txt");
    const checkoutBytes = Buffer.from([0x01, 0x02, 0x03, 0xff, 0xfe, 0x5a, 0x7b]);
    writeFileSync(checkoutFile, checkoutBytes);

    const codegraphDir = join(repoDir, ".codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    const indexFile = join(codegraphDir, "index.db");
    const indexBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x64]);
    writeFileSync(indexFile, indexBytes);

    mockSync.mockRejectedValue(new Error("Sync failed intentionally"));

    const workerCtx = {
      dir: repoDir,
      repoUrl: "https://test.local/repo.git",
      branch: "main",
      codeGraphId: "cg-1",
      setInternalStatus: vi.fn(),
      setPageProgress: vi.fn(),
      taskContext: {} as any,
    } as any;

    await expect(mod.cgService["worker"](workerCtx)).rejects.toThrow("Sync failed intentionally");

    expect(mockFetch).not.toHaveBeenCalled();

    // Directory should not be deleted, binary checkout AND .codegraph index bytes preserved
    expect(existsSync(checkoutFile)).toBe(true);
    expect(readFileSync(checkoutFile)).toEqual(checkoutBytes);

    expect(existsSync(indexFile)).toBe(true);
    expect(readFileSync(indexFile)).toEqual(indexBytes);
  });

  it("successful replacement opens a fresh handle and does not reuse the closed instance, with strict close-before-sync order", async () => {
    const mod = createKnowledgeModule({
      dataDir: workDir,
      db: dbInstance.db,
      llmConfig: {} as any
    });

    const repoDir = join(workDir, "repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const mockOldInstance = { projectRoot: repoDir };
    const mockNewInstance = { projectRoot: repoDir, isNew: true };

    mod.instancePool.set("cg-1", mockOldInstance as any);

    const callOrder: string[] = [];
    mockCloseIndex.mockImplementation(() => callOrder.push("closeIndex"));
    mockSync.mockImplementation(async () => {
      callOrder.push("sync");
      return { version: "abcdef", localPath: repoDir, sourceType: "git" };
    });
    mockOpenIndex.mockImplementation(async () => {
      callOrder.push("openIndex");
      return mockNewInstance;
    });
    mockSyncIndex.mockImplementation(async () => {
      callOrder.push("syncIndex");
    });

    const workerCtx = {
      dir: repoDir,
      repoUrl: "https://test.local/repo.git",
      branch: "main",
      codeGraphId: "cg-1",
      setInternalStatus: vi.fn(),
      setPageProgress: vi.fn(),
      taskContext: {} as any,
    } as any;

    await mod.cgService["worker"](workerCtx);

    expect(mockCloseIndex).toHaveBeenCalledWith(mockOldInstance);
    expect(mockSync).toHaveBeenCalled();
    expect(mockOpenIndex).toHaveBeenCalledWith(repoDir);
    expect(mod.instancePool.get("cg-1")).toBe(mockNewInstance);

    // Check strict invocation order
    expect(callOrder).toEqual(["closeIndex", "sync", "openIndex", "syncIndex"]);
  });

  it("syncIndex rejection closes fresh handle, leaves pool empty and releases guard", async () => {
    const mod = createKnowledgeModule({
      dataDir: workDir,
      db: dbInstance.db,
      llmConfig: {} as any
    });

    const repoDir = join(workDir, "repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    const mockNewInstance = { projectRoot: repoDir, isNew: true };

    mockSync.mockResolvedValue({ version: "abcdef", localPath: repoDir, sourceType: "git" });
    mockOpenIndex.mockResolvedValue(mockNewInstance);
    mockSyncIndex.mockRejectedValue(new Error("Index sync rejected"));

    const workerCtx = {
      dir: repoDir,
      repoUrl: "https://test.local/repo.git",
      branch: "main",
      codeGraphId: "cg-1",
      setInternalStatus: vi.fn(),
      setPageProgress: vi.fn(),
      taskContext: {} as any,
    } as any;

    await expect(mod.cgService["worker"](workerCtx)).rejects.toThrow("Index sync rejected");

    expect(mockCloseIndex).toHaveBeenCalledWith(mockNewInstance);
    expect(mod.instancePool.get("cg-1")).toBeUndefined();
    // Guard must be released, so a new acquire Guard should succeed
    expect(mod.instancePool.acquireGuard!("cg-1")).toBe(true);
    mod.instancePool.releaseGuard!("cg-1");
  });

  it("blocked sync cannot lazily reopen old index", async () => {
    const mod = createKnowledgeModule({
      dataDir: workDir,
      db: dbInstance.db,
      llmConfig: {} as any
    });

    const repoDir = join(workDir, "repo");

    // Acquire guard simulates an active sync
    expect(mod.instancePool.acquireGuard!("cg-1")).toBe(true);

    // Attempting to lazily load while guard is held should return undefined immediately
    const result = await mod.instancePool.loadIfMissing!("cg-1", repoDir);
    expect(result).toBeUndefined();
    expect(mockOpenIndex).not.toHaveBeenCalled();

    mod.instancePool.releaseGuard!("cg-1");
  });

  it("lazy open that completes after a full mutation cycle is discarded (generation counter)", async () => {
    const mod = createKnowledgeModule({
      dataDir: workDir,
      db: dbInstance.db,
      llmConfig: {} as any
    });

    const repoDir = join(workDir, "repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    let resolveOpen: (val: any) => void;
    const lazyOpenPromise = new Promise(resolve => resolveOpen = resolve);
    mockOpenIndex.mockReturnValueOnce(lazyOpenPromise);

    // 1. Start lazy load
    const loadPromise = mod.instancePool.loadIfMissing!("cg-1", repoDir);

    // 2. Mutation starts and finishes before openIndex resolves
    expect(mod.instancePool.acquireGuard!("cg-1")).toBe(true);
    mod.instancePool.releaseGuard!("cg-1");

    // 3. Lazy load's openIndex resolves
    const mockStaleInstance = { stale: true };
    resolveOpen!(mockStaleInstance);

    const result = await loadPromise;

    // Must be rejected because generation advanced
    expect(result).toBeUndefined();
    expect(mockCloseIndex).toHaveBeenCalledWith(mockStaleInstance);
    expect(mod.instancePool.get("cg-1")).toBeUndefined();
  });

  it("acquireGuard closes and removes old pooled handle", async () => {
    const mod = createKnowledgeModule({
      dataDir: workDir,
      db: dbInstance.db,
      llmConfig: {} as any
    });

    const mockOldInstance = { projectRoot: "test" };
    mod.instancePool.set("cg-1", mockOldInstance as any);

    expect(mod.instancePool.acquireGuard!("cg-1")).toBe(true);

    // Old instance must be closed and removed synchronously
    expect(mockCloseIndex).toHaveBeenCalledWith(mockOldInstance);
    // During mutation, get returns undefined
    expect(mod.instancePool.get("cg-1")).toBeUndefined();

    mod.instancePool.releaseGuard!("cg-1");
    // After release, it remains undefined (since it was deleted)
    expect(mod.instancePool.get("cg-1")).toBeUndefined();
  });
});
