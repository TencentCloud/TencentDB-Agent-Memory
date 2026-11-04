import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSkillRouteTable, type SkillRouterDeps } from "./skill-handlers.js";
import { SkillCore } from "../core/skill/skill-core.js";
import { SqliteSkillStore } from "../core/store/sqlite/skill-store.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { SkillResourceStore } from "../core/skill/skill-resource-store.js";
import { SkillVersioning } from "../core/skill/skill-versioning.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const ids = { team_id: "team-a", agent_id: "agent-a", user_id: "user-a" };
const content =
  "---\nname: http-demo\ndescription: HTTP integration skill\n---\nRead guide.md";
const gitHash = (bytes: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(bytes)}\0${bytes}`)
    .digest("hex");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "skill-http-"));
  const db = new DatabaseSync(":memory:");
  cleanup.push(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = new SqliteSkillStore({ db, dimensions: 0 });
  store.init();
  const storage = new StorageAdapter(new LocalStorageBackend(dir));
  const resources = new SkillResourceStore({ storage });
  let branch = "a".repeat(40);
  const refs: string[] = [];
  // Only GitHub HTTP is substituted; local HTTP, routing, database and files are real.
  const githubFetch: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/commits/")) {
      const ref = decodeURIComponent(path.split("/commits/")[1]);
      refs.push(ref);
      const sha = ref === "main" ? branch : ref;
      return Response.json({ sha, commit: { tree: { sha } } });
    }
    if (path.includes("/git/trees/")) {
      const rev = path.split("/git/trees/")[1];
      return Response.json({
        truncated: false,
        tree: [
          {
            path: "SKILL.md",
            mode: "100644",
            type: "blob",
            size: Buffer.byteLength(content),
            sha: gitHash(content),
          },
          {
            path: "guide.md",
            mode: "100644",
            type: "blob",
            size: 1,
            sha: gitHash(rev[0]),
          },
        ],
      });
    }
    const bytes = [content, "a", "b"].find((b) => path.endsWith(gitHash(b)));
    if (bytes === undefined)
      throw new Error(`Unexpected GitHub request: ${url}`);
    return Response.json({
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
    });
  };
  const core = new SkillCore({
    store,
    resources,
    versioning: new SkillVersioning({ store, resources, storage }),
    githubFetch,
  });
  const deps = {
    getSkillCore: () => core,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as SkillRouterDeps;
  const routes = makeSkillRouteTable();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await routes[req.url!](
        JSON.parse(Buffer.concat(chunks).toString()),
        { apiKey: "test", serviceId: "local" },
        "http-test",
        deps,
      );
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
  const address = server.address() as { port: number };
  const call = async (action: string, body: unknown) =>
    (
      await fetch(`http://127.0.0.1:${address.port}/v3/skill/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json() as Promise<any>;
  return {
    call,
    refs,
    store,
    deps,
    moveBranch: () => {
      branch = "b".repeat(40);
    },
  };
}
describe("GitHub Skill HTTP workflow", () => {
  it("runs preview, pinned install, check, upgrade, historical reads and detach over HTTP", async () => {
    const f = await fixture();
    const location = {
      repository: "https://github.com/example/skills",
      ref: "main",
    };
    const p = await f.call("github/preview", { ...ids, ...location });
    expect(p.code).toBe(0);
    expect((await f.store.listSkills({ team_id: ids.team_id })).total).toBe(0);
    f.moveBranch();
    const installed = await f.call("github/apply", {
      ...ids,
      ...location,
      expected_version: 0,
      commit: p.data.source.commit,
      digest: p.data.source.digest,
    });
    expect(installed.code).toBe(0);
    expect(installed.data.version).toBe(1);
    expect(f.refs).toEqual(["main", "a".repeat(40)]);
    const skill_id = installed.data.skill_id;
    const update = await f.call("github/preview", { ...ids, skill_id });
    expect(update.data.update_available).toBe(true);
    expect(update.data.files.changed).toEqual(["guide.md"]);
    const applied = await f.call("github/apply", {
      ...ids,
      skill_id,
      expected_version: 1,
      commit: update.data.source.commit,
      digest: update.data.source.digest,
    });
    expect(applied.code).toBe(0);
    expect(applied.data.version).toBe(2);
    const old = await f.call("files/read", {
      ...ids,
      skill_id,
      version: 1,
      path: "guide.md",
    });
    const current = await f.call("files/read", {
      ...ids,
      skill_id,
      path: "guide.md",
    });
    expect(old.data.content).toBe("a");
    expect(current.data.content).toBe("b");
    const detached = await f.call("github/detach", {
      ...ids,
      skill_id,
      expected_version: 2,
    });
    expect(detached.code).toBe(0);
    expect(detached.data.version).toBe(3);
    expect(detached.data.metadata?.github_source).toBeUndefined();
  });
  it("rejects malformed requests and never falls back from an unresolved service", async () => {
    const f = await fixture();
    expect((await f.call("github/preview", {})).code).toBe(40001);
    expect(f.refs).toEqual([]);
    f.deps.resolveSkillCore = async () => undefined;
    expect(
      (
        await f.call("github/preview", {
          ...ids,
          repository: "https://github.com/example/skills",
        })
      ).code,
    ).toBe(40401);
    expect(f.refs).toEqual([]);
  });
});
