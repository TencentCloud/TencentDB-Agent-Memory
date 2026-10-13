import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";

// All variables referenced by hoisted vi.mock factories are initialized via vi.hoisted
const {
  mockLogInfo,
  mockLogDebug,
  mockLogError,
  mockLogWarn,
  largeMockDirName,
  dummyFileName,
  mockCodeGraphInstance,
  mockCodeGraphOpen,
  mockCodeGraphInit,
  mockIsInitialized,
} = vi.hoisted(() => {
  const mockLogInfo = vi.fn();
  const mockLogDebug = vi.fn();
  const mockLogError = vi.fn();
  const mockLogWarn = vi.fn();
  const largeMockDirName = "large-mocked-limit-dir";
  const dummyFileName = "dummy.txt";
  const instance = {
    getStats: vi.fn(() => ({ files: 0 })),
    sync: vi.fn().mockResolvedValue({ filesChanged: 0 }),
    indexAll: vi.fn().mockResolvedValue(undefined),
  };
  const mockCodeGraphOpen = vi.fn().mockResolvedValue(instance);
  const mockCodeGraphInit = vi.fn().mockResolvedValue(instance);
  const mockIsInitialized = vi.fn().mockReturnValue(false);

  return {
    mockLogInfo,
    mockLogDebug,
    mockLogError,
    mockLogWarn,
    largeMockDirName,
    dummyFileName,
    mockCodeGraphInstance: instance,
    mockCodeGraphOpen,
    mockCodeGraphInit,
    mockIsInitialized,
  };
});

vi.mock("../src/logger.js", () => {
  return {
    createLogger: () => ({
      info: mockLogInfo,
      debug: mockLogDebug,
      error: mockLogError,
      warn: mockLogWarn,
    }),
  };
});

// Narrowly mocked filesystem module only for the large-limit count case.
// Keeps real fixtures intact for all other tests.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (path: string, options?: any) => {
      if (path.toString().includes(largeMockDirName)) {
        return new Array(100001).fill(dummyFileName);
      }
      return actual.readdir(path, options);
    },
    lstat: async (path: string, options?: any) => {
      if (path.toString().includes(dummyFileName)) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as any;
      }
      return actual.lstat(path, options);
    },
  };
});

// Mock the codegraph module to ensure SDK methods are not invoked
vi.mock("@colbymchenry/codegraph", () => {
  return {
    CodeGraph: {
      open: mockCodeGraphOpen,
      init: mockCodeGraphInit,
    },
    isInitialized: mockIsInitialized,
  };
});

import { validateProjectBoundary } from "../src/engines/code/guard.js";
import { openIndex, indexProject, syncIndex, executeTool } from "../src/engines/code/bridge.js";

describe("CodeGraph Project Boundary Guard", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "codegraph-boundary-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("accepts a valid regular directory and binary index without mutating bytes", async () => {
    await mkdir(join(tmpRoot, ".codegraph"));
    // Binary acceptance fixture with actual Buffer bytes including zero and non-UTF8
    const binaryBytes = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0x80]);
    const indexPath = join(tmpRoot, ".codegraph", "index.sqlite");
    await writeFile(indexPath, binaryBytes);
    await writeFile(join(tmpRoot, "index.js"), "console.log('hello')");

    await expect(validateProjectBoundary(tmpRoot)).resolves.toBeUndefined();

    // Verify unchanged bytes
    const readBytes = await readFile(indexPath);
    expect(readBytes.equals(binaryBytes)).toBe(true);
  });

  it("rejects a regular file as project root", async () => {
    const rootFile = join(tmpRoot, "rootFile.txt");
    await writeFile(rootFile, "content");
    await expect(validateProjectBoundary(rootFile)).rejects.toThrow("project root must be a directory");
  });

  it("rejects root symlink", async () => {
    const realDir = await mkdtemp(join(tmpdir(), "codegraph-real-"));
    const symlinkRoot = join(tmpRoot, "symlink-root");
    await symlink(realDir, symlinkRoot);

    await expect(validateProjectBoundary(symlinkRoot)).rejects.toThrow("symlinks are not allowed");

    await rm(realDir, { recursive: true, force: true });
  });

  it("rejects nested directory escape (symlink outside)", async () => {
    const outsideParent = await mkdtemp(join(tmpdir(), "codegraph-outside-parent-"));
    const outsideDir = join(outsideParent, "outside-dir");
    await mkdir(outsideDir);
    await symlink(outsideDir, join(tmpRoot, "outside-link"));

    await expect(validateProjectBoundary(tmpRoot)).rejects.toThrow("symlinks are not allowed");

    await rm(outsideParent, { recursive: true, force: true });
  });

  it("rejects file escape (symlink to outside file)", async () => {
    const outsideParent = await mkdtemp(join(tmpdir(), "codegraph-outside-parent-"));
    const outsideFile = join(outsideParent, "codegraph-outside-file.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, join(tmpRoot, "file-link"));

    await expect(validateProjectBoundary(tmpRoot)).rejects.toThrow("symlinks are not allowed");

    await rm(outsideParent, { recursive: true, force: true });
  });

  it("rejects dangling symlink", async () => {
    await symlink(join(tmpRoot, "does-not-exist"), join(tmpRoot, "dangling"));
    await expect(validateProjectBoundary(tmpRoot)).rejects.toThrow("symlinks are not allowed");
  });

  it("rejects in-root symlink", async () => {
    await mkdir(join(tmpRoot, "subdir"));
    await symlink(join(tmpRoot, "subdir"), join(tmpRoot, "in-root-link"));
    await expect(validateProjectBoundary(tmpRoot)).rejects.toThrow("symlinks are not allowed");
  });

  it("rejects excessive directory depth", async () => {
    let current = tmpRoot;
    for (let i = 0; i < 105; i++) {
      current = join(current, "dir");
      await mkdir(current);
    }
    await expect(validateProjectBoundary(tmpRoot)).rejects.toThrow("maximum directory depth exceeded");
  });

  it("rejects non-regular/non-directory special entry (UNIX socket)", async () => {
    const socketPath = join(tmpRoot, "test.sock");
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.on("error", reject);
      });
      await expect(validateProjectBoundary(tmpRoot)).rejects.toThrow("invalid entry type detected");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("rejects excessive entry limit using narrowly mocked filesystem", async () => {
    // This uses the vi.mock("node:fs/promises") setup from the top of the file
    const mockRoot = join(tmpRoot, largeMockDirName);
    await mkdir(mockRoot);

    await expect(validateProjectBoundary(mockRoot)).rejects.toThrow("maximum entry limit exceeded");
  });

  describe("Bridge API integration", () => {
    it("does not invoke SDK methods (init/open/indexAll) on rejected trees for openIndex", async () => {
      await symlink(join(tmpRoot, "nonexistent"), join(tmpRoot, "bad"));
      await expect(openIndex(tmpRoot)).rejects.toThrow("symlinks are not allowed");

      const codegraph = await import("@colbymchenry/codegraph");
      expect(codegraph.CodeGraph.open).not.toHaveBeenCalled();
      expect(codegraph.CodeGraph.init).not.toHaveBeenCalled();
      expect(mockCodeGraphInstance.indexAll).not.toHaveBeenCalled();
    });

    it("does not invoke SDK methods (init/open/indexAll) on rejected trees for indexProject", async () => {
      await symlink(join(tmpRoot, "nonexistent"), join(tmpRoot, "bad"));
      await expect(indexProject(tmpRoot)).rejects.toThrow("symlinks are not allowed");

      const codegraph = await import("@colbymchenry/codegraph");
      expect(codegraph.CodeGraph.open).not.toHaveBeenCalled();
      expect(codegraph.CodeGraph.init).not.toHaveBeenCalled();
      expect(codegraph.isInitialized).not.toHaveBeenCalled();
      expect(mockCodeGraphInstance.indexAll).not.toHaveBeenCalled();
    });

    it("detects symlink introduced after handle creation (point-in-time re-validation)", async () => {
      // Use directly supplied checked instance spies for sync/tool rejection
      const mockCgInstance = {
        cg: { sync: vi.fn() },
        handler: { execute: vi.fn() },
        projectRoot: tmpRoot,
      };

      // Now introduce a symlink
      await symlink(join(tmpRoot, "nonexistent"), join(tmpRoot, "later-link"));

      await expect(syncIndex(mockCgInstance as any)).rejects.toThrow("symlinks are not allowed");
      expect(mockCgInstance.cg.sync).not.toHaveBeenCalled();

      await expect(executeTool(mockCgInstance as any, "codegraph_search", { query: "test" })).rejects.toThrow("symlinks are not allowed");
      expect(mockCgInstance.handler.execute).not.toHaveBeenCalled();
    });

    it("successfully runs sync and executeTool on a valid tree without leaking secrets in logs", async () => {
      const validInstance = {
        cg: { sync: vi.fn().mockResolvedValue({ filesChanged: 1 }) },
        handler: { execute: vi.fn().mockResolvedValue({ content: [{ text: "secret-result" }], isError: false }) },
        projectRoot: tmpRoot,
      };

      await writeFile(join(tmpRoot, "valid.js"), "const x = 1;");

      mockLogInfo.mockClear();
      mockLogDebug.mockClear();

      const syncRes = await syncIndex(validInstance as any);
      expect(syncRes.changed).toBe(1);
      expect(validInstance.cg.sync).toHaveBeenCalled();

      const toolRes = await executeTool(validInstance as any, "codegraph_search", { query: "my-secret-key" });
      expect(toolRes.text).toBe("secret-result");
      expect(validInstance.handler.execute).toHaveBeenCalledWith("codegraph_search", { query: "my-secret-key", limit: 10 });

      // Add logger mock assertions that synthetic secret params/result content/previews are absent
      const allLogs = [...mockLogInfo.mock.calls, ...mockLogDebug.mock.calls];
      expect(allLogs.length).toBeGreaterThan(0);
      for (const call of allLogs) {
        const payload = JSON.stringify(call);
        expect(payload).not.toContain("my-secret-key");
        expect(payload).not.toContain("secret-result");
      }
    });
  });
});
