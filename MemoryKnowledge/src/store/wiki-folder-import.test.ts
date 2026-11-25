import fs, { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { WikiService } from "./wiki-service.js";
import { evictWikiDb } from "../engines/wiki/index-db.js";
import {
  getReadDb,
  withWriteDb,
  listSources,
  readSourceStates,
  recordSourceIngestResult,
  classifySources,
  sha256Bytes,
} from "../engines/wiki/index-db.js";
import { createWikiRoutes } from "../routes/wiki.js";
import { createWikiSourceManager } from "../engines/wiki/manager.js";
import { extractSource } from "../engines/wiki/ingest-v2/index.js";
import type { LlmClient } from "../engines/wiki/ingest-v2/llm.js";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { deleteSourceFiles } from "../engines/wiki/ingest-v2/cascade.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-folder-"));
  const { db, raw } = createDb({ path: path.join(dir, "metadata.db") });
  const store = new SqliteKnowledgeStore(db);
  const service = new WikiService({ store, dataRoot: dir, worker: async () => ({}) });
  const { row } = service.create({ service_id: "service-a", team_id: "team-a", name: "handbook" });
  cleanup.push(() => {
    evictWikiDb(row.wiki_id);
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, service, row, store };
}

describe("Wiki folder import", () => {
  it("persists same-basename sources in separate subdirectories and lists both", () => {
    const { service, row } = fixture();
    const files = [
      { filename: "handbook/team-a/README.md", content: "alpha" },
      { filename: "handbook/team-b/README.md", content: "beta" },
    ];
    expect(service.rawWriteMany("service-a", "team-a", row.wiki_id, files)).toEqual(
      files.map((f) => ({ filename: f.filename, size: f.content.length })),
    );
    for (const file of files)
      expect(service.rawRead("service-a", "team-a", row.wiki_id, file.filename)).toBe(file.content);
    expect(service.rawLs("service-a", "team-a", row.wiki_id)?.map((f) => f.filename)).toEqual(
      files.map((f) => f.filename),
    );
  });
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
});

function sources(f: ReturnType<typeof fixture>) {
  return listSources(
    getReadDb(f.row.wiki_id, f.service.dirFor("service-a", "team-a", f.row.wiki_id)),
  );
}
function write(
  f: ReturnType<typeof fixture>,
  files: { filename: string; content: string | Buffer }[],
) {
  return f.service.rawWriteMany("service-a", "team-a", f.row.wiki_id, files);
}

it("preserves ingested state, timestamps, source identity and disk mtime on replay; only changed/new files need extraction", () => {
  const f = fixture();
  const files = [
    { filename: "root/a/README.md", content: "alpha" },
    { filename: "root/b/README.md", content: "beta" },
  ];
  write(f, files);
  const wikiDir = f.service.dirFor("service-a", "team-a", f.row.wiki_id);
  withWriteDb(wikiDir, (db) => {
    for (const source of sources(f)) recordSourceIngestResult(db, { ...source, ok: true });
  });
  const before = sources(f);
  const filename = path.join(wikiDir, "raw/sources", files[0].filename);
  fs.utimesSync(filename, 1000000000, 1000000000);
  write(f, files);
  expect(sources(f)).toEqual(before);
  expect(fs.statSync(filename).mtimeMs).toBe(1000000000000);
  write(f, [
    { ...files[0], content: "alpha updated" },
    { filename: "root/c/README.md", content: "gamma" },
  ]);
  const after = sources(f);
  expect(after.find((s) => s.filename === files[1].filename)).toEqual(before[1]);
  const states = readSourceStates(getReadDb(f.row.wiki_id, wikiDir));
  const disk = after.map((s) => ({
    filename: s.filename,
    sha256: sha256Bytes(fs.readFileSync(path.join(wikiDir, "raw/sources", s.filename))),
  }));
  expect(classifySources(disk, states)).toEqual({
    toIngest: [files[0].filename, "root/c/README.md"],
    skipped: [files[1].filename],
    deleted: [],
  });
});

it("rolls back a failed batch without truncating an existing file, then retries successfully", () => {
  const f = fixture();
  const old = [
    { filename: "root/a.md", content: "old alpha" },
    { filename: "root/b.md", content: "old beta" },
  ];
  write(f, old);
  const before = sources(f);
  const rename = fs.renameSync;
  let calls = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (++calls === 2) throw new Error("injected storage failure");
    rename(from, to);
  });
  const changed = old.map((item) => ({ ...item, content: "updated " + item.content }));
  expect(() => write(f, changed)).toThrow("injected storage failure");
  for (const item of old)
    expect(f.service.rawRead("service-a", "team-a", f.row.wiki_id, item.filename)).toBe(
      item.content,
    );
  expect(sources(f)).toEqual(before);
  const root = path.join(
    f.service.dirFor("service-a", "team-a", f.row.wiki_id),
    "raw/sources/root",
  );
  expect(fs.readdirSync(root).sort()).toEqual(["a.md", "b.md"]);
  vi.mocked(renameSync).mockImplementation(fs.renameSync);
  write(f, changed);
  for (const item of changed)
    expect(f.service.rawRead("service-a", "team-a", f.row.wiki_id, item.filename)).toBe(
      item.content,
    );
});

it("recovers after a process stops between file persistence and source registration", () => {
  const f = fixture();
  const files = [
    { filename: "root/a.md", content: "alpha" },
    { filename: "root/b.md", content: "beta" },
  ];
  const dir = path.join(f.service.dirFor("service-a", "team-a", f.row.wiki_id), "raw/sources/root");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.md"), "alpha");
  expect(sources(f)).toEqual([]);
  write(f, files);
  write(f, files);
  expect(sources(f).map((s) => [s.filename, s.sha256])).toEqual(
    files.map((s) => [s.filename, sha256Bytes(Buffer.from(s.content))]),
  );
});

it.each([
  "../outside.md",
  "root/../../outside.md",
  "/absolute.md",
  "root/./a.md",
  "root//a.md",
  "root\\a.md",
  "root/\0.md",
])("rejects %s before writing the valid member of a batch", (filename) => {
  const f = fixture();
  expect(
    write(f, [
      { filename: "root/valid.md", content: "valid" },
      { filename, content: "invalid" },
    ]),
  ).toBe("invalid_path");
  expect(sources(f)).toEqual([]);
  expect(f.service.rawRead("service-a", "team-a", f.row.wiki_id, "root/valid.md")).toBeNull();
});

it("rejects a symlink into another team's sources", () => {
  const f = fixture();
  const other = f.service.create({
    service_id: "service-a",
    team_id: "team-b",
    name: "handbook",
  }).row;
  cleanup.push(() => evictWikiDb(other.wiki_id));
  f.service.rawWrite("service-a", "team-b", other.wiki_id, "secret.md", "private");
  const root = path.join(f.service.dirFor("service-a", "team-a", f.row.wiki_id), "raw/sources");
  fs.symlinkSync(
    path.join(f.service.dirFor("service-a", "team-b", other.wiki_id), "raw/sources"),
    path.join(root, "link"),
  );
  expect(write(f, [{ filename: "link/secret.md", content: "overwrite" }])).toBe("invalid_path");
  expect(f.service.rawRead("service-a", "team-b", other.wiki_id, "secret.md")).toBe("private");
});

it("isolates the same folder paths by team and rejects mismatched service/team/wiki IDs through the HTTP route", async () => {
  const f = fixture();
  const other = f.service.create({
    service_id: "service-a",
    team_id: "team-b",
    name: "handbook",
  }).row;
  cleanup.push(() => evictWikiDb(other.wiki_id));
  const app = createWikiRoutes({
    wikiService: f.service,
    wikiMgr: createWikiSourceManager(path.join(f.dir, "manager")),
    publicBaseUrl: "http://localhost/v3",
  });
  const request = (service: string, team: string, wiki: string, content: string) =>
    app.request("/raw/write", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": service },
      body: JSON.stringify({
        team_id: team,
        wiki_id: wiki,
        files: [
          {
            filename: "root/README.md",
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          },
        ],
      }),
    });
  expect((await request("service-a", "team-a", f.row.wiki_id, "alpha")).status).toBe(200);
  expect((await request("service-a", "team-b", other.wiki_id, "beta")).status).toBe(200);
  expect((await request("service-a", "team-a", other.wiki_id, "intruder")).status).toBe(404);
  expect((await request("service-b", "team-a", f.row.wiki_id, "intruder")).status).toBe(404);
  expect(f.service.rawRead("service-a", "team-a", f.row.wiki_id, "root/README.md")).toBe("alpha");
  expect(f.service.rawRead("service-a", "team-b", other.wiki_id, "root/README.md")).toBe("beta");
});

it("keeps nested source provenance in generated pages instead of collapsing to the basename", async () => {
  const f = fixture();
  const filename = "handbook/engineering/README.md";
  write(f, [{ filename, content: "Engineering handbook" }]);
  const dir = f.service.dirFor("service-a", "team-a", f.row.wiki_id);
  const llm = {
    chat: async () =>
      '<<<FILE path="wiki/concepts/engineering.md">>>\n---\ntype: concept\ntitle: Engineering\n---\nHandbook.\n<<<END>>>',
  } as unknown as LlmClient;
  const pages = await extractSource(dir, path.join(dir, "raw/sources", filename), {}, [], {
    llm,
    mode: "single-stage",
  });
  expect([...pages.values()][0]).toContain(filename);
});

it("runs real HTTP uploads and incremental ingestion: no-op replay, one changed source, failed extraction and retry", async () => {
  const f = fixture();
  const wikiDir = f.service.dirFor("service-a", "team-a", f.row.wiki_id);
  const manager = createWikiSourceManager(path.join(f.dir, "manager"));
  manager.register({ name: f.row.wiki_id, path: wikiDir });
  let failBeta = false;
  const requests: string[] = [];
  // Only the external model is deterministic; SDK, HTTP, conversion, ingestion,
  // page writes and SQLite source/index transactions are the production code.
  const llm = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const prompt: string = payload.messages.at(-1).content;
    requests.push(prompt);
    const source = prompt.match(/^## Source to (?:analyze|ingest): (.+)/)?.[1];
    if (failBeta && source === "handbook/b/README.md") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "injected model failure", type: "invalid_request_error" },
        }),
      );
      return;
    }
    const revision = /\nREV2\n/.test(prompt) ? "revised" : "original";
    const title = `${source?.includes("/b/") ? "Beta" : "Alpha"} ${revision}`;
    const content = source
      ? `<<<FILE path="wiki/concepts/${title.replace(/ /g, "-").toLowerCase()}.md">>>\n---\ntype: concept\ntitle: ${title}\n---\n${title} knowledge.\n<<<END>>>`
      : "Overview of [[Alpha original]] and [[Beta original]].";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  const close = (server: Server) =>
    new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const llmPort = (llm.address() as { port: number }).port;
  const app = createWikiRoutes({
    wikiService: f.service,
    wikiMgr: manager,
    publicBaseUrl: "http://localhost/v3",
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const config = {
    apiKey: "local-test-only",
    baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    model: "fixture",
    timeoutMs: 5000,
  };
  const original = [
    { filename: "handbook/a/README.md", content: "Alpha handbook" },
    { filename: "handbook/b/README.md", content: "Beta handbook" },
  ];
  const upload = async (files: typeof original) => {
    const response = await fetch(`http://127.0.0.1:${port}/raw/write`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": "service-a" },
      body: JSON.stringify({
        team_id: "team-a",
        wiki_id: f.row.wiki_id,
        files: files.map((file) => ({
          ...file,
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        })),
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).code).toBe(0);
  };
  try {
    await upload(original);
    const first = await manager.ingest(f.row.wiki_id, config);
    expect(first.map((r) => r.source).sort()).toEqual(original.map((r) => r.filename));
    expect(first.every((r) => !r.error && r.filesWritten.length > 0)).toBe(true);
    expect(sources(f).map((s) => s.status)).toEqual(["ingested", "ingested"]);
    for (const [index, title] of ["alpha-original", "beta-original"].entries()) {
      expect(fs.readFileSync(path.join(wikiDir, `wiki/concepts/${title}.md`), "utf8")).toContain(
        original[index].filename,
      );
    }
    const beforeReplay = sources(f);
    const requestCount = requests.length;
    await upload(original);
    expect(await manager.ingest(f.row.wiki_id, config)).toEqual([]);
    expect(requests).toHaveLength(requestCount);
    expect(sources(f)).toEqual(beforeReplay);

    await upload([{ ...original[0], content: "Alpha handbook\nREV2\n" }]);
    const changed = await manager.ingest(f.row.wiki_id, config);
    expect(changed.map((r) => r.source)).toEqual([original[0].filename]);
    expect(changed[0].error).toBeNull();
    expect(sources(f)[1]).toEqual(beforeReplay[1]);

    await upload([{ ...original[1], content: "Beta handbook\nREV2\n" }]);
    failBeta = true;
    await expect(manager.ingest(f.row.wiki_id, config)).rejects.toThrow(
      "all source documents failed",
    );
    expect(sources(f).map((s) => s.status)).toEqual(["ingested", "failed"]);
    failBeta = false;
    const unchangedAlpha = sources(f)[0];
    const retry = await manager.ingest(f.row.wiki_id, config);
    expect(retry.map((r) => r.source)).toEqual([original[1].filename]);
    expect(retry[0].error).toBeNull();
    expect(sources(f)[0]).toEqual(unchangedAlpha);
    expect(sources(f).map((s) => s.status)).toEqual(["ingested", "ingested"]);
    expect(manager.search(f.row.wiki_id, "Beta revised", 10).results.length).toBeGreaterThan(0);
  } finally {
    await close(server as Server);
    await close(llm);
  }
}, 20000);

it("deletes only pages attributed to the selected nested source, preserving same-basename siblings", async () => {
  const f = fixture();
  const dir = f.service.dirFor("service-a", "team-a", f.row.wiki_id);
  write(f, [
    { filename: "root/a/README.md", content: "alpha" },
    { filename: "root/b/README.md", content: "beta" },
    { filename: "README.md", content: "loose" },
  ]);
  const pagesDir = path.join(dir, "wiki/concepts");
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const [title, source] of [
    ["alpha", "root/a/README.md"],
    ["beta", "root/b/README.md"],
    ["loose", "README.md"],
  ]) {
    fs.writeFileSync(
      path.join(pagesDir, `${title}.md`),
      `---\ntitle: ${title}\ntype: concept\nsources:\n  - ${source}\n---\n${title} knowledge.`,
    );
  }
  await deleteSourceFiles(dir, [path.join(dir, "raw/sources/root/a/README.md")]);
  expect(fs.existsSync(path.join(pagesDir, "alpha.md"))).toBe(false);
  expect(fs.existsSync(path.join(pagesDir, "beta.md"))).toBe(true);
  expect(fs.existsSync(path.join(pagesDir, "loose.md"))).toBe(true);
});

it("does not mark a newer upload ingested when an older extraction finishes during a folder upload", () => {
  const f = fixture();
  const filename = "root/README.md";
  write(f, [{ filename, content: "original" }]);
  const inFlight = sources(f)[0];
  write(f, [{ filename, content: "updated while extraction was in flight" }]);
  const pending = sources(f)[0];
  const dir = f.service.dirFor("service-a", "team-a", f.row.wiki_id);
  withWriteDb(dir, (db) => recordSourceIngestResult(db, { ...inFlight, ok: true }));
  expect(sources(f)[0]).toEqual(pending);
  expect(sources(f)[0].status).toBe("uploaded");
  withWriteDb(dir, (db) => recordSourceIngestResult(db, { ...pending, ok: true }));
  expect(sources(f)[0].status).toBe("ingested");
});
