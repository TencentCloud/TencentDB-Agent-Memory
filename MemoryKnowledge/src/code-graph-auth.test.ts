import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "./db/client.js";
import { createKnowledgeModule, type KnowledgeModule } from "./module.js";
import { SourceFetcherRegistry } from "./source-fetcher/registry.js";
import type { ISourceFetcher } from "./source-fetcher/types.js";

vi.mock("./engines/code/index.js", async (original) => {
  const actual = await original<typeof import("./engines/code/index.js")>();
  const instance = async (dir: string) => ({ projectRoot: dir, cg: {}, handler: {} });
  return { ...actual, openIndex: instance, indexProject: instance,
    syncIndex: async () => ({ changed: 1 }), closeIndex: () => {},
    getStats: () => ({ fileCount: 1, nodeCount: 1, edgeCount: 0 }) };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv("KNOWLEDGE_AUTO_SYNC_ENABLED", "false");
  vi.stubEnv("CODE_SOURCE_ENABLED", "gongfeng");
  const root = mkdtempSync(join(tmpdir(), "knowledge-auth-refresh-"));
  const connection = createDb({ path: join(root, "metadata.sqlite") });
  const fetcher = {
    supportedType: "git" as const, validate: () => {},
    fetch: vi.fn<ISourceFetcher["fetch"]>(async (url, _branch, dir) => {
      execFileSync("git", ["init", "--quiet", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
      mkdirSync(join(dir, ".codegraph"), { recursive: true });
      writeFileSync(join(dir, ".codegraph", "index.db"), "index");
      return { localPath: dir, version: "commit-1", sourceType: "git" };
    }),
    sync: vi.fn<ISourceFetcher["sync"]>(async (_url, _branch, dir) => ({
      localPath: dir, version: "commit-2", sourceType: "git",
    })),
  };
  vi.spyOn(SourceFetcherRegistry.prototype, "resolve").mockReturnValue(fetcher);
  const key = { keyPath: "/test/key", knownHostsPath: "/test/known_hosts", pubPath: "/test/key.pub", publicKey: "test", created: false };
  const sshKeyStore = { get: vi.fn(() => key), ensure: vi.fn(async () => key) };
  const module: KnowledgeModule = createKnowledgeModule({
    dataDir: root, db: connection.db, sshKeyStore,
    llmConfig: { mode: "custom", protocol: "openai", provider: "", model: "", apiKey: "", baseUrl: "", maxTokens: 100, timeoutMs: 1000 },
  });
  cleanups.push(async () => {
    await module.cgService.onIdle();
    module.autoSyncScheduler.stop();
    module.dataRootOwnership.release();
    connection.raw.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, module, fetcher, sshKeyStore };
}

describe("CodeGraph authenticated candidate builds", () => {
  it("clones private candidates with credentials and strips them before promotion", async () => {
    const f = fixture();
    const { row } = f.module.cgService.create({ service_id: "svc", team_id: "team", owner_user_id: "owner",
      repo_url: "https://example.com/private.git", branch: "main",
      credential: { provider_id: "gongfeng", secret: "test-token" } });
    await f.module.cgService.onIdle();
    const dir = f.module.cgService.dirFor("svc", "team", row.code_graph_id);
    expect(f.module.cgService.getById("svc", row.code_graph_id)?.status).toBe("ready");
    expect(f.fetcher.fetch.mock.calls[0][0]).toContain("test-token");
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("test-token");
    await f.module.cgService.sync("svc", "team", row.code_graph_id);
    await f.module.cgService.onIdle();
    expect(f.fetcher.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetcher.fetch.mock.calls[1][2]).not.toBe(dir);
    expect(f.fetcher.sync).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("test-token");
    expect(f.module.cgService.getById("svc", row.code_graph_id)?.status).toBe("ready");
  });

  it("passes the asset owner's SSH key to clone and refresh and preserves readiness if it disappears", async () => {
    const f = fixture();
    const { row } = f.module.cgService.create({ service_id: "svc", team_id: "team", owner_user_id: "owner",
      user_id: "requester", repo_url: "ssh://git@example.com/repo.git", branch: "main" });
    await f.module.cgService.onIdle();
    expect(f.sshKeyStore.get).toHaveBeenCalledWith("svc", "owner");
    const opts = { ssh: { keyPath: "/test/key", knownHostsPath: "/test/known_hosts" } };
    expect(f.fetcher.fetch.mock.calls[0][3]).toEqual(opts);
    await f.module.cgService.sync("svc", "team", row.code_graph_id);
    await f.module.cgService.onIdle();
    expect(f.fetcher.sync.mock.calls[0][3]).toEqual(opts);
    f.sshKeyStore.get.mockImplementation(() => { throw new Error("SSH key unavailable"); });
    await f.module.cgService.sync("svc", "team", row.code_graph_id);
    await f.module.cgService.onIdle();
    expect(f.module.cgService.getById("svc", row.code_graph_id)).toMatchObject({
      status: "ready", has_last_good: true, commit_hash: "commit-2", sync_error: "SSH key unavailable",
    });
  });
});
