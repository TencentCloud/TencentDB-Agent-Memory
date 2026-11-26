import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoSourceFetcher } from "./repo-fetcher.js";
import { createRepoGit, type RepoGit } from "./repo-git.js";
import { SourceFetcherRegistry } from "./registry.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-repo-fixture-"));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository(path: string, content: string) {
  const dir = fixtureDir();
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, path), content);
  git(dir, "add", "--", path);
  git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture");
  return dir;
}

function fixtures() {
  const manifest = repository("default.xml", `<manifest>
    <remote name="origin" fetch="https://forge.example/"/><default remote="origin" revision="main"/>
    <project name="products/service" path="apps/server">
      <copyfile src="server.ts" dest="bootstrap.ts"/>
      <linkfile src="server.ts" dest="launch.ts"/>
    </project>
    <project name="products/ui" path="apps/client" revision="refs/tags/stable"/>
  </manifest>`);
  const server = repository("server.ts", "export function serve() { return 'server'; }\n");
  const client = repository("client.ts", "export function open() { return 'client'; }\n");
  git(client, "tag", "stable");
  const local = new Map([
    ["https://forge.example/manifest", manifest],
    ["https://forge.example/products/service", server],
    ["https://forge.example/products/ui", client],
  ]);
  const fetches: string[] = [];
  const preflight: string[][] = [];
  let failUrl = "";
  const gitFixture: RepoGit = {
    async prepare(urls) {
      preflight.push([...urls]);
      for (const url of urls) if (!local.has(url)) throw new Error("Unknown fixture remote");
    },
    async fetch(url, revision, directory, bare) {
      fetches.push(url);
      if (url === failUrl) throw new Error("Fixture fetch refused");
      const remote = local.get(url)!;
      execFileSync("git", ["init", "--quiet", ...(bare ? ["--bare"] : []), directory]);
      git(directory, "fetch", "--quiet", "--depth=1", `file://${remote}`, revision);
      const commit = git(directory, "rev-parse", "FETCH_HEAD^{commit}").trim();
      if (!bare) git(directory, "checkout", "--detach", "--quiet", commit);
      return commit;
    },
    async readFile(directory, commit, path) {
      return git(directory, "show", `${commit}:${path}`);
    },
  };
  return {
    fetcher: new RepoSourceFetcher(() => gitFixture), fetches, preflight, server,
    fail(url: string) { failUrl = url; },
  };
}

const source = "repo+https://forge.example/manifest";

describe("repo manifest checkout", () => {
  it("checks out real Git projects and includes their pinned commits in the version", async () => {
    const { fetcher, preflight, server } = fixtures();
    const workspace = join(fixtureDir(), "workspace");
    const initial = await fetcher.fetch(source, "main", workspace);
    expect(initial.sourceType).toBe("repo-manifest");
    expect(initial.version).toMatch(/^[a-f0-9]{64}$/);
    expect(preflight).toEqual([
      ["https://forge.example/manifest"],
      ["https://forge.example/products/ui", "https://forge.example/products/service"],
    ]);
    expect(readFileSync(join(workspace, "bootstrap.ts"), "utf8")).toContain("serve()");
    expect(readlinkSync(join(workspace, "launch.ts"))).toBe("apps/server/server.ts");
    expect(readFileSync(join(workspace, "apps/client/client.ts"), "utf8")).toContain("open()");

    writeFileSync(join(server, "server.ts"), "export const version = 2;\n");
    git(server, "add", "server.ts");
    git(server, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "update");
    const updated = await fetcher.sync(source, "main", workspace);
    expect(updated.version).not.toBe(initial.version);
    expect(readFileSync(join(workspace, "bootstrap.ts"), "utf8")).toContain("version = 2");
  });

  it("preserves the old checkout when one member fails during refresh", async () => {
    const { fetcher, fail } = fixtures();
    const workspace = join(fixtureDir(), "workspace");
    await fetcher.fetch(source, "main", workspace);
    fail("https://forge.example/products/ui");
    await expect(fetcher.sync(source, "main", workspace)).rejects.toThrow("apps/client");
    expect(existsSync(join(workspace, "apps/client/client.ts"))).toBe(true);
    expect(readFileSync(join(workspace, "bootstrap.ts"), "utf8")).toContain("serve()");
  });

  it("selects the manifest fetcher without changing ordinary Git source routing", () => {
    const registry = new SourceFetcherRegistry();
    expect(registry.resolve(source).supportedType).toBe("repo-manifest");
    expect(registry.resolve("https://forge.example/manifest").supportedType).toBe("git");
  });

  it("refuses a non-public destination during production preflight", async () => {
    await expect(createRepoGit().prepare(["https://127.0.0.1/fixture"]))
      .rejects.toThrow("public addresses");
  });
});
