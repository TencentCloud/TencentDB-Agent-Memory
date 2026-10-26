import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { createWikiRoutes } from "../src/routes/wiki.js";
import { createServiceAuthMiddleware } from "../src/middleware/auth.js";
const dispose: (() => void)[] = [];
afterEach(() => { for (const cleanup of dispose.splice(0)) cleanup(); vi.restoreAllMocks(); });
const KEY = "synthetic-export-key";
function setup(key = KEY, outerAuth = true) {
  const root = fs.mkdtempSync(join(tmpdir(), "okf-export-api-")); const { db, raw } = createDb({ path: ":memory:" });
  dispose.push(() => { raw.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new SqliteKnowledgeStore(db); const worker = vi.fn(async () => ({}));
  const service = new WikiService({ store, dataRoot: join(root, "data"), worker });
  const row = service.create({ service_id: "service-a", team_id: "team-a", name: "existing" }).row;
  store.updateWikiStatus("service-a", row.wiki_id, { status: "ready" });
  const wiki = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki"); fs.mkdirSync(join(wiki, "nested"), { recursive: true });
  const expected: Record<string, Buffer> = { "index.md": Buffer.from('---\nokf_version: "0.2"\n---\nIndex'), "nested/fact.md": Buffer.from("---\ntype: custom\n---\nŁódź 東京"), "ref.py": Buffer.from("raise Exception('never executed')"), "opaque.bin": Buffer.from([0, 255, 128]), "empty.txt": Buffer.alloc(0), "z.txt": Buffer.from("last") };
  for (const [path, data] of Object.entries(expected)) fs.writeFileSync(join(wiki, path), data);
  fs.writeFileSync(join(wiki, ".private"), "synthetic-only-private-text");
  const manager = createWikiSourceManager(join(root, "manager")); const app = new Hono(); const api = new Hono();
  if (outerAuth) api.use("*", createServiceAuthMiddleware({ serviceKey: key }, "/custom"));
  api.route("/wiki", createWikiRoutes({ wikiService: service, wikiMgr: manager, publicBaseUrl: "http://test/custom/wiki", serviceAuth: { serviceKey: key } })); app.route("/custom", api);
  const ids = { team_id: "team-a", wiki_id: row.wiki_id };
  const post = (body: BodyInit = JSON.stringify(ids), headers: Record<string, string> = {}, route = "okf/export") => app.request(new Request("http://test/custom/wiki/" + route, { method: "POST", headers: { authorization: "Bearer " + KEY, "x-tdai-service-id": "service-a", "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit & { duplex: "half" }));
  return { root, wiki, row, service, store, worker, manager, expected, ids, post };
}
function snapshot(root: string) { return Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(String).sort().map(p => { const f = join(root, p); return [p, fs.lstatSync(f).isFile() ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : "directory"]; })); }
function stream(size: number) { let left = size; return new ReadableStream<Uint8Array>({ pull(c) { if (!left) c.close(); else { const n = Math.min(left, 4096); left -= n; c.enqueue(new Uint8Array(n).fill(32)); } } }); }

describe("authenticated native bundle HTTP export", () => {
  it("exports exact visible bytes without changing metadata/files or indexing", async () => {
    const { post, root, row, store, worker, manager, expected } = setup(); const before = snapshot(root); const metadata = store.getWikiById("service-a", row.wiki_id);
    const response = await post(); expect(response.status).toBe(200); const data = await response.json(); expect(data.code).toBe(0);
    expect(data.data.files.map((f: { path: string }) => f.path)).toEqual(Object.keys(expected).sort());
    for (const f of data.data.files) { expect(f.encoding).toBe("base64"); expect(Buffer.compare(Buffer.from(f.content, "base64"), expected[f.path]!)).toBe(0); }
    expect(JSON.stringify(data)).not.toContain("synthetic-only-private-text"); expect(snapshot(root)).toEqual(before);
    expect(store.getWikiById("service-a", row.wiki_id)).toEqual(metadata); expect(worker).not.toHaveBeenCalled(); expect(manager.get(row.wiki_id)).toBeUndefined();
  });
  it.each([true, false])("requires credentials even with outer middleware=%s", async outer => {
    const { post, service } = setup(KEY, outer); const read = vi.spyOn(service, "get");
    expect((await post(undefined, { authorization: "" })).status).toBe(401); expect((await post(undefined, { authorization: "Bearer invalid" })).status).toBe(401); expect(read).not.toHaveBeenCalled();
  });
  it("disables full export without a key while retaining existing legacy read behavior", async () => {
    const { post, ids, service } = setup("", false); const read = vi.spyOn(service, "get");
    expect((await post(undefined, { authorization: "" })).status).toBe(503); expect(read).not.toHaveBeenCalled();
    expect((await post(JSON.stringify(ids), { authorization: "" }, "get")).status).toBe(200);
  });
  it.each(["service", "team", "wiki"])("refuses a foreign/missing %s identity", async which => {
    const { post, ids, root } = setup(); const before = snapshot(root);
    const body = { ...ids, ...(which === "team" ? { team_id: "team-b" } : which === "wiki" ? { wiki_id: "missing-wiki" } : {}) };
    const response = await post(JSON.stringify(body), which === "service" ? { "x-tdai-service-id": "service-b" } : {});
    expect(response.status).toBe(404); expect(snapshot(root)).toEqual(before);
  });
  it.each(["service", "team", "wiki"])("rejects unsafe %s selectors before filesystem access", async which => {
    const { post, ids } = setup(); const body = { ...ids, ...(which === "team" ? { team_id: "../escape" } : which === "wiki" ? { wiki_id: "../escape" } : {}) };
    expect((await post(JSON.stringify(body), which === "service" ? { "x-tdai-service-id": "../escape" } : {})).status).toBe(400);
  });
  it.each(["pending", "processing"] as const)("refuses %s Wikis", async status => {
    const { post, row, store } = setup(); store.updateWikiStatus("service-a", row.wiki_id, { status }); expect((await post()).status).toBe(409);
  });
  it.each(["budget", "path", "link", "root-link"])("sanitizes real filesystem refusal: %s", async kind => {
    const { post, wiki, root } = setup(); const marker = "synthetic-private-entry";
    if (kind === "budget") { const p = join(wiki, marker); fs.writeFileSync(p, ""); fs.truncateSync(p, 64 * 1024 * 1024); }
    if (kind === "path") fs.writeFileSync(join(wiki, marker + "\n.md"), "opaque");
    if (kind === "link") fs.symlinkSync(join(root, "absent-private-target"), join(wiki, marker));
    if (kind === "root-link") { fs.renameSync(wiki, wiki + "-retained"); fs.symlinkSync(wiki + "-retained", wiki); }
    const response = await post(); expect(response.status).toBe(kind.includes("link") ? 409 : 400); const text = await response.text(); expect(text).not.toContain(root); expect(text).not.toContain(marker);
  });
  it("accepts exactly 32 KiB of selector JSON and bounds actual bytes with a misleading declaration", async () => {
    const { post, ids } = setup(); const s = JSON.stringify(ids); expect((await post(s + " ".repeat(32 * 1024 - s.length))).status).toBe(200);
    expect((await post(stream(32 * 1024 + 1), { "content-length": "1" })).status).toBe(413);
    expect((await post(undefined, { "content-length": String(32 * 1024 + 1) })).status).toBe(413);
  });
  it("accepts an exact 10 MiB file payload", async () => {
    const { post, wiki } = setup(); fs.rmSync(wiki, { recursive: true }); fs.mkdirSync(wiki); const path = join(wiki, "exact.bin"); fs.writeFileSync(path, ""); fs.truncateSync(path, 10 * 1024 * 1024);
    const response = await post(); expect(response.status).toBe(200); const result = await response.json(); expect(Buffer.from(result.data.files[0].content, "base64").length).toBe(10 * 1024 * 1024);
  });
  it("refuses malformed JSON/media/root/UTF-8 without leaking payloads", async () => {
    const { post } = setup(); for (const body of ["[]", "null", "{}", "private malformed JSON"]) expect((await post(body)).status).toBe(400);
    expect((await post(new Uint8Array([255]))).status).toBe(400); expect((await post(undefined, { "content-type": "text/plain" })).status).toBe(415);
  });
  it("contains stream and backend exceptions without coercion or response leakage", async () => {
    const { post, service } = setup(); const body = new ReadableStream({ start(c) { c.error(new Error("synthetic-private-fault")); } });
    const streamResponse = await post(body); expect(streamResponse.status).toBe(500); expect(await streamResponse.text()).not.toContain("synthetic-private-fault");
    const coerce = vi.fn(() => { throw new Error("synthetic-private-fault"); }); vi.spyOn(service, "get").mockImplementation(() => { throw { toString: coerce }; });
    const response = await post(); expect(response.status).toBe(500); expect(await response.text()).not.toContain("synthetic-private-fault"); expect(coerce).not.toHaveBeenCalled();
  });
});
