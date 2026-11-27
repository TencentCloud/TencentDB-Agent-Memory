import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeGraphHandleCloseError, indexProject, syncIndex, type CodeGraphInstance } from "./bridge.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "knowledge-code-bridge-"));
  roots.push(root);
  writeFileSync(join(root, "hello.ts"), "export const answer = 42;\n");
  return root;
}

async function codeGraphClass(): Promise<any> {
  const mod = createRequire(import.meta.url)("@colbymchenry/codegraph");
  return mod.CodeGraph;
}

describe("CodeGraph bridge indexing contract", () => {
  it("rejects a non-throwing lock refusal and closes the newly opened database", async () => {
    const root = projectRoot();
    const CodeGraph = await codeGraphClass();
    const close = vi.spyOn(CodeGraph.prototype, "close");
    vi.spyOn(CodeGraph.prototype, "indexAll").mockResolvedValue({
      success: false,
      filesIndexed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      errors: [{ severity: "error", message: "Could not acquire file lock" }],
      durationMs: 0,
    });

    await expect(indexProject(root)).rejects.toThrow("Could not acquire file lock");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a partial index even if CodeGraph reports success", async () => {
    const root = projectRoot();
    const CodeGraph = await codeGraphClass();
    const close = vi.spyOn(CodeGraph.prototype, "close");
    vi.spyOn(CodeGraph.prototype, "indexAll").mockResolvedValue({
      success: true,
      filesDiscovered: 2,
      filesIndexed: 1,
      filesSkipped: 0,
      filesErrored: 0,
      errors: [],
      durationMs: 1,
    });

    await expect(indexProject(root)).rejects.toThrow("CodeGraph index incomplete");
    expect(close).toHaveBeenCalledOnce();
  });

  it("accepts a completed scan with a small number of file errors", async () => {
    const root = projectRoot();
    const CodeGraph = await codeGraphClass();
    vi.spyOn(CodeGraph.prototype, "indexAll").mockResolvedValue({
      success: true, filesDiscovered: 5000, filesIndexed: 4999,
      filesSkipped: 0, filesErrored: 1,
      errors: [{ severity: "error", code: "read_error", filePath: "vendor/broken.ts", message: "vendor file unreadable" }],
    });
    const instance = await indexProject(root);
    instance.cg.close();
  });

  it.each([
    { filesIndexed: 4989, filesErrored: 26, errors: [] },
    { filesIndexed: 0, filesErrored: 1, errors: [] },
    { filesIndexed: 4999, filesErrored: 1, errors: [{ severity: "error", message: "database failure" }] },
    { filesIndexed: 4999, filesErrored: 1, errors: [{ severity: "error", code: "path_traversal", filePath: "../outside.ts" }] },
    { filesIndexed: 5000, filesErrored: 0, errors: [{ severity: "error", code: "read_error", filePath: "vendor/broken.ts" }] },
  ])("rejects excessive, wholly failed, or fatal scans: %j", async (counts) => {
    const root = projectRoot();
    const CodeGraph = await codeGraphClass();
    const close = vi.spyOn(CodeGraph.prototype, "close");
    vi.spyOn(CodeGraph.prototype, "indexAll").mockResolvedValue({
      success: true, filesSkipped: 0, ...counts,
    });
    await expect(indexProject(root)).rejects.toThrow("CodeGraph index incomplete");
    expect(close).toHaveBeenCalledOnce();
  });

  it("exposes a handle when closing after an indexing failure also fails", async () => {
    const root = projectRoot();
    const CodeGraph = await codeGraphClass();
    const originalClose = CodeGraph.prototype.close;
    vi.spyOn(CodeGraph.prototype, "close").mockImplementation(() => { throw new Error("close failed"); });
    vi.spyOn(CodeGraph.prototype, "indexAll").mockResolvedValue({
      success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0,
      errors: [{ severity: "error", message: "index locked" }], durationMs: 0,
    });

    let failure: unknown;
    try { await indexProject(root); }
    catch (err) { failure = err; }
    expect(failure).toBeInstanceOf(CodeGraphHandleCloseError);
    const unclosed = (failure as CodeGraphHandleCloseError).unclosedInstance;
    expect(unclosed.projectRoot).toBe(root);
    expect(unclosed.cg).toBeTruthy();
    originalClose.call(unclosed.cg);
  });

  it("rejects a zero-result sync when indexing never began", async () => {
    const root = projectRoot();
    const sync = vi.fn().mockResolvedValue({
      filesChecked: 0,
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: 0,
      durationMs: 0,
    });
    const instance = { projectRoot: root, cg: { sync }, handler: {} } as CodeGraphInstance;

    await expect(syncIndex(instance)).rejects.toThrow("index lock unavailable");
    expect(sync).toHaveBeenCalledOnce();
  });

  it("accepts an empty-project sync that actually started", async () => {
    const root = projectRoot();
    const sync = vi.fn(async ({ onProgress }: { onProgress: () => void }) => {
      onProgress();
      return {
        filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, durationMs: 0,
      };
    });
    const instance = { projectRoot: root, cg: { sync }, handler: {} } as CodeGraphInstance;

    await expect(syncIndex(instance)).resolves.toEqual({ changed: 0 });
  });
});
