import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { createDb } from "../db/client.js";
import { createKnowledgeModule } from "../module.js";
import { RepoSourceFetcher } from "../source-fetcher/repo-fetcher.js";
import { SourceFetcherRegistry } from "../source-fetcher/registry.js";
import { createCodeGraphRoutes } from "./code-graph.js";
import { createToolsRoutes } from "./tools.js";

const SOURCE = "repo+https://forge.example/manifest";
const paths: string[] = [];

afterEach(() => {
  for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(directory: string, file: string, content: string) {
  writeFileSync(join(directory, file), content);
  git(directory, "add", "--", file);
  git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-manifest-http-"));
  paths.push(root);

  function repo(file: string, text: string) {
    const dir = mkdtempSync(join(root, "remote-"));
    git(dir, "init", "-q", "-b", "main");
    commit(dir, file, text);
    return dir;
  }

  const manifest = repo("default.xml", `<manifest>
    <remote name="origin" fetch="https://forge.example/"/>
    <default remote="origin" revision="main"/>
    <project name="api" path="apps/api"/>
    <project name="core" path="libs/core"/>
  </manifest>`);
  const api = repo("api.ts", `import { coreFeature } from "../../libs/core/core";
export function apiEntry() { return coreFeature(); }
`);
  const core = repo("core.ts", "export function coreFeature() { return 'one'; }\n");
  const remotes = new Map([
    ["https://forge.example/manifest", manifest],
    ["https://forge.example/api", api],
    ["https://forge.example/core", core],
  ]);

  let beforeCoreFetch: (() => Promise<void>) | undefined;
  const registry = new SourceFetcherRegistry();
  registry.register(new RepoSourceFetcher(() => ({
    async prepare(urls) {
      for (const url of urls) if (!remotes.has(url)) throw new Error("unknown fixture remote");
    },
    async fetch(url, revision, directory, bare) {
      if (url === "https://forge.example/core") await beforeCoreFetch?.();
      execFileSync("git", ["init", "-q", ...(bare ? ["--bare"] : []), directory]);
      git(directory, "fetch", "-q", "--depth=1", `file://${remotes.get(url)}`, revision);
      const revisionId = git(directory, "rev-parse", "FETCH_HEAD^{commit}");
      if (!bare) git(directory, "checkout", "-q", "--detach", revisionId);
      return revisionId;
    },
    async readFile(dir, revision, path) { return git(dir, "show", `${revision}:${path}`); },
  })));
  const dataDir = join(root, "data");
  const { db, raw } = createDb({ path: join(root, "knowledge.sqlite") });

  function start() {
    const knowledge = createKnowledgeModule({
      db, dataDir, llmConfig: {
        mode: "proxy", protocol: "openai", provider: "", baseUrl: "", apiKey: "", model: "", maxTokens: 1024, timeoutMs: 5000,
      },
      sourceFetcherRegistry: registry,
    });
    const app = new Hono()
      .route("/code-graph", createCodeGraphRoutes({ ...knowledge, publicBaseUrl: "" }))
      .route("/tools", createToolsRoutes(knowledge));
    return {
      async post(path: string, body: Record<string, unknown>, tenant = "service-a") {
        const res = await app.request(path, {
          method: "POST", body: JSON.stringify(body),
          headers: { "content-type": "application/json", "x-tdai-service-id": tenant },
        });
        return { status: res.status, ...(await res.json()) };
      },
    };
  }

  return { start, raw, dataDir, api, core, beforeCoreFetch: (fn?: () => Promise<void>) => { beforeCoreFetch = fn; } };
}

it("keeps the last aggregate queryable during a partial refresh failure and after restart, then publishes the retry", async () => {
  const fixture = createFixture();
  let app = fixture.start();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  try {
    const creation = await app.post("/code-graph/create", { team_id: "team-a", repo_url: SOURCE });
    expect(creation.status).toBe(201);
    const id: string = creation.data.code_graph_id;
    const get = () => app.post("/code-graph/get", { code_graph_id: id });
    const sync = () => app.post("/code-graph/sync", { code_graph_id: id });
    const search = (query: string) => app.post("/code-graph/search", { code_graph_id: id, query });
    const tool = (tool_name: string, params: Record<string, unknown>) =>
      app.post("/tools/call", { knowledge_id: id, tool_name, params });

    await vi.waitFor(async () => expect((await get()).data.status).toBe("ready"), { timeout: 8_000 });
    const original = (await get()).data;
    const repeated = await app.post("/code-graph/create", { team_id: "team-a", repo_url: `${SOURCE}#default.xml` });
    expect(repeated.status).toBe(200);
    expect(repeated.data.code_graph_id).toBe(id);
    expect(original.commit_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(original.repo_url).toBe(`${SOURCE}#default.xml`);
    expect((await search("apiEntry")).data.text).toContain("apps/api/api.ts");
    expect((await search("coreFeature")).data.text).toContain("libs/core/core.ts");
    expect((await tool("callers", { symbol: "coreFeature" })).data.text).toContain("apiEntry");
    const scoped = await tool("search", { query: "coreFeature", projectPath: fixture.dataDir });
    expect(scoped.data.text).toContain("libs/core/core.ts");
    expect((await app.post("/code-graph/search", { code_graph_id: id, query: "coreFeature" }, "service-b")).status).toBe(404);

    commit(fixture.api, "api.ts", "export function apiReplacement() { return 2; }\n");
    git(fixture.core, "branch", "-m", "temporarily-unavailable");
    fixture.beforeCoreFetch(async () => { entered.resolve(); await resume.promise; });
    expect((await sync()).status).toBe(202);
    await entered.promise;
    expect((await get()).data.status).toBe("processing");
    expect((await sync()).status).toBe(409);
    expect((await search("apiEntry")).data.text).toContain("apps/api/api.ts");
    resume.resolve();
    await vi.waitFor(async () => expect((await get()).data.status).toBe("failed"), { timeout: 8_000 });
    const failed = (await get()).data;
    expect(failed.sync_error).toContain("libs/core");
    expect(failed.commit_hash).toBe(original.commit_hash);
    expect(failed.last_sync_at).toBe(original.last_sync_at);
    expect((await search("apiEntry")).data.text).toContain("apps/api/api.ts");
    expect((await search("apiReplacement")).data.text).not.toContain("apps/api/api.ts");

    app = fixture.start();
    expect((await tool("search", { query: "coreFeature" })).data.text).toContain("libs/core/core.ts");
    expect((await tool("callers", { symbol: "coreFeature" })).data.text).toContain("apiEntry");
    expect(readdirSync(join(fixture.dataDir, "service-a", "team-a", id))).toEqual([original.commit_hash]);

    git(fixture.core, "branch", "-m", "main");
    fixture.beforeCoreFetch();
    expect((await sync()).status).toBe(202);
    await vi.waitFor(async () => expect((await get()).data.status).toBe("ready"), { timeout: 8_000 });
    expect((await get()).data.commit_hash).not.toBe(original.commit_hash);
    expect((await get()).data.sync_error).toBeNull();
    expect((await search("apiReplacement")).data.text).toContain("apps/api/api.ts");
    expect((await search("apiEntry")).data.text).not.toContain("apps/api/api.ts");
    expect((await search("coreFeature")).data.text).toContain("libs/core/core.ts");

    const updated = (await get()).data;
    expect((await sync()).status).toBe(202);
    await vi.waitFor(async () => expect((await get()).data.status).toBe("ready"), { timeout: 8_000 });
    expect((await get()).data.commit_hash).toBe(updated.commit_hash);
    expect(readdirSync(join(fixture.dataDir, "service-a", "team-a", id))).toEqual([updated.commit_hash]);
  } finally {
    resume.resolve();
    fixture.raw.close();
  }
}, 30_000);

it("rejects invalid or credentialed manifests before creating a resource", async () => {
  const fixture = createFixture();
  const app = fixture.start();
  try {
    for (const input of [
      { repo_url: `${SOURCE}#..%2Fdefault.xml` },
      { repo_url: SOURCE, branch: "-invalid" },
      { repo_url: SOURCE, provider_id: "ssh" },
      { repo_url: SOURCE, secret: "fixture-secret" },
    ]) {
      const result = await app.post("/code-graph/create", { team_id: "team-a", ...input });
      expect(result.status).toBe(400);
    }
    const { data } = await app.post("/code-graph/list", { team_id: "team-a" });
    expect(data.items).toEqual([]);
  } finally {
    fixture.raw.close();
  }
});


it("never exposes a partial graph when the first checkout fails", async () => {
  const fixture = createFixture();
  const app = fixture.start();
  try {
    git(fixture.core, "branch", "-m", "unavailable");
    const creation = await app.post("/code-graph/create", { team_id: "team-a", repo_url: SOURCE });
    expect(creation.status).toBe(201);
    const id: string = creation.data.code_graph_id;
    await vi.waitFor(async () => {
      const { data } = await app.post("/code-graph/get", { code_graph_id: id });
      expect(data.status).toBe("failed");
      expect(data.commit_hash).toBeNull();
    }, { timeout: 8_000 });
    const search = await app.post("/code-graph/search", { code_graph_id: id, query: "apiEntry" });
    expect(search.data).toEqual({ text: "", isError: false });
    expect(readdirSync(join(fixture.dataDir, "service-a", "team-a", id))).toEqual([]);
  } finally {
    fixture.raw.close();
  }
}, 10_000);
