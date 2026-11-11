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

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const payload = { files: [{ path: "concept.md", content: "---\ntype: custom\n---\nOriginal bytes" }] };
function setup(key = "synthetic-preflight-key") {
  const root = fs.mkdtempSync(join(tmpdir(), "preflight-http-"));
  const { db, raw } = createDb({ path: ":memory:" });
  cleanups.push(() => { raw.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = new SqliteKnowledgeStore(db); const worker = vi.fn(async () => ({}));
  const service = new WikiService({ store, dataRoot: join(root, "data"), worker });
  const row = service.create({ service_id: "service-a", team_id: "team-a", name: "existing" }).row;
  const manager = createWikiSourceManager(join(root, "manager"));
  const app = new Hono(); const api = new Hono();
  api.use("*", createServiceAuthMiddleware({ serviceKey: key }, "/v3"));
  api.route("/wiki", createWikiRoutes({ wikiService: service, wikiMgr: manager, publicBaseUrl: "http://test/v3/wiki" }));
  app.route("/v3", api);
  const post = (body: BodyInit = JSON.stringify(payload), headers: Record<string, string> = {}) => app.request(new Request("http://test/v3/wiki/okf/validate", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-preflight-key", "x-tdai-service-id": "service-a", ...headers }, body, duplex: "half",
  } as RequestInit & { duplex: "half" }));
  return { root, store, row, worker, manager, post };
}
function snapshot(root: string) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(String).sort().map(p => {
    const full = join(root, p); const stat = fs.lstatSync(full);
    return [p, stat.isFile() ? createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "directory"];
  }));
}
function stream(size: number) {
  let remaining = size;
  return new ReadableStream<Uint8Array>({ pull(c) { if (!remaining) c.close(); else { const n = Math.min(remaining, 64 * 1024); remaining -= n; c.enqueue(new Uint8Array(n).fill(32)); } } });
}

describe("native OKF HTTP preflight integration", () => {
  it("validates without changing existing SQLite rows/files, indexing or invoking a worker", async () => {
    const { post, root, store, row, worker, manager } = setup(); const before = snapshot(root);
    const existing = store.getWikiById("service-a", row.wiki_id);
    const response = await post(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, data: { files: 1, concepts: 1, warnings: [] } });
    expect(snapshot(root)).toEqual(before); expect(store.getWikiById("service-a", row.wiki_id)).toEqual(existing);
    expect(worker).not.toHaveBeenCalled(); expect(manager.get(row.wiki_id)).toBeUndefined();
  });
  it.each(["", "Bearer invalid"])("uses the existing configured-key authentication for %j", async authorization => {
    const { post } = setup(); expect((await post(undefined, { authorization })).status).toBe(401);
  });
  it("preserves upstream's empty-key policy rather than adding a hidden authentication bypass", async () => {
    const { post } = setup(""); expect((await post(undefined, { authorization: "" })).status).toBe(200);
  });
  it.each(["", "../foreign"])("requires a valid service header: %j", async service => {
    expect((await setup().post(undefined, { "x-tdai-service-id": service })).status).toBe(400);
  });
  it.each(["{}", "[]", "null", '{"private":"unterminated'])("refuses malformed input without echoing it: %s", async body => {
    const response = await setup().post(body); expect(response.status).toBe(400); expect(await response.text()).not.toContain("unterminated");
  });
  it("does not echo sensitive filenames from validation exceptions", async () => {
    const response = await setup().post(JSON.stringify({ files: [{ path: "private-filename.md", content: "missing frontmatter" }] }));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("private-filename");
  });
  it("requires JSON media type and rejects malformed UTF-8", async () => {
    const { post } = setup(); expect((await post(undefined, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(new Uint8Array([255]))).status).toBe(400);
  });
  it.each([{}, { "content-length": "1" }])("bounds actual streamed bytes regardless of content-length %j", async headers => {
    expect((await setup().post(stream(20 * 1024 * 1024 + 1), headers)).status).toBe(413);
  });
  it("refuses an oversized declaration before parsing", async () => {
    expect((await setup().post(undefined, { "content-length": String(20 * 1024 * 1024 + 1) })).status).toBe(413);
  });
  it("accepts exactly 20 MiB of valid JSON with trailing whitespace", async () => {
    const json = JSON.stringify(payload); const body = json + " ".repeat(20 * 1024 * 1024 - Buffer.byteLength(json));
    expect((await setup().post(body)).status).toBe(200);
  });
  it("accepts the exact decoded base64 budget and refuses one extra byte", async () => {
    const { post } = setup();
    for (const extra of [0, 1]) {
      const body = { files: [{ path: "opaque.bin", content: Buffer.alloc(10 * 1024 * 1024 + extra).toString("base64"), encoding: "base64" }] };
      expect((await post(JSON.stringify(body))).status).toBe(extra ? 400 : 200);
    }
  });
  it("keeps request-stream faults generic", async () => {
    const body = new ReadableStream({ start(c) { c.error(new Error("synthetic-private-stream-fault")); } });
    const response = await setup().post(body); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-private-stream-fault");
  });
});
