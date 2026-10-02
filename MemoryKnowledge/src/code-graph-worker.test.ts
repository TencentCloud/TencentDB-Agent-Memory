// Regression for #1516: the incremental-sync failure path used to rmSync the
// existing checkout+index before attempting the fallback fresh clone, so a
// transient remote failure destroyed the last known-good state and left the
// graph "failed" with an empty directory.
//
// Contract after the fix (createCodeGraphWorker, dependency-injected):
//   1. incremental sync fails, staged fresh clone succeeds → directory swapped
//      to the staged content;
//   2. incremental sync fails AND staged clone fails → error propagates AND the
//      previous good directory survives untouched (the whole point of #1516);
//   3. no existing repo → plain clone into the target dir (unchanged behaviour).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeGraphWorker } from "./code-graph-worker.js";

let dir: string;
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cg-worker-"));
  dir = join(base, "graph");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function seedExistingRepo(): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: old", "utf-8");
  writeFileSync(join(dir, "old-file.txt"), "last known good", "utf-8");
}

function makeDeps(opts: {
  syncError?: Error;
  fetchError?: Error;
  staged?: { version: string };
}) {
  const setCalls: string[] = [];
  const instance = { tag: "instance" };
  return {
    setCalls,
    deps: {
      resolveFetcher: () => ({
        sync: async () => {
          if (opts.syncError) throw opts.syncError;
          return { version: "synced" };
        },
        fetch: async (_url: string, _branch: string, target: string) => {
          if (opts.fetchError) throw opts.fetchError;
          // simulate a real clone: materialize a .git so the staged dir is a repo
          mkdirSync(join(target, ".git"), { recursive: true });
          writeFileSync(join(target, "new-file.txt"), "fresh clone", "utf-8");
          return { version: opts.staged?.version ?? "fresh" };
        },
      }),
      instancePool: {
        get: () => undefined,
        set: (id: string, i: unknown) => {
          setCalls.push(`${id}:${(i as { tag: string }).tag}`);
        },
      },
      openIndex: async (d: string) => ({ tag: `open:${d}` }),
      syncIndex: async () => undefined,
      indexProject: async (d: string) => ({ tag: `index:${d}` }),
      getStats: () => ({ files: 3, nodes: 4, edges: 5 }),
      log: { info: () => {}, warn: () => {} },
    },
  };
}

const CTX = (dir: string) => ({
  codeGraphId: "cg-1",
  serviceId: "svc",
  teamId: "team",
  repoUrl: "https://example.com/repo.git",
  branch: "main",
  dir,
  setInternalStatus: (s: string) => undefined,
});

describe("code-graph worker sync fallback (#1516)", () => {
  it("incremental fails + staged clone succeeds → directory swapped to staged content", async () => {
    seedExistingRepo();
    const { deps } = makeDeps({ syncError: new Error("network unreachable"), staged: { version: "abc123" } });
    const worker = createCodeGraphWorker(deps);

    const res = await worker(CTX(dir));

    expect(res.commitHash).toBe("abc123");
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, "new-file.txt"))).toBe(true);
    expect(existsSync(join(dir, "old-file.txt"))).toBe(false); // swapped, not merged
    expect(existsSync(`${dir}.staging`)).toBe(false); // staging cleaned up by rename
  });

  it("incremental fails AND staged clone fails → error propagates, previous good directory survives", async () => {
    seedExistingRepo();
    const { deps } = makeDeps({
      syncError: new Error("network unreachable"),
      fetchError: new Error("network still unreachable"),
    });
    const worker = createCodeGraphWorker(deps);

    await expect(worker(CTX(dir))).rejects.toThrow("network still unreachable");

    // the whole point of #1516: last known-good state must survive
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(readFileSync(join(dir, ".git", "HEAD"), "utf-8")).toBe("ref: old");
    expect(readFileSync(join(dir, "old-file.txt"), "utf-8")).toBe("last known good");
    expect(existsSync(`${dir}.staging`)).toBe(false); // staging cleaned up on failure
  });

  it("no existing repo → clones straight into the target dir (unchanged behaviour)", async () => {
    const { deps } = makeDeps({ staged: { version: "first" } });
    const worker = createCodeGraphWorker(deps);

    const res = await worker(CTX(dir));

    expect(res.commitHash).toBe("first");
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, "new-file.txt"))).toBe(true);
  });

  it("incremental success → no clone, no staging, existing repo kept in place", async () => {
    seedExistingRepo();
    const { deps } = makeDeps({ staged: { version: "unused" } });
    const worker = createCodeGraphWorker(deps);

    const res = await worker(CTX(dir));

    expect(res.commitHash).toBe("synced");
    expect(existsSync(join(dir, "old-file.txt"))).toBe(true);
    expect(existsSync(join(dir, "new-file.txt"))).toBe(false);
  });
});
