import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createServiceAuthMiddleware } from "../src/middleware/auth.js";

const key = "synthetic-configured-service-key";
const marker = "synthetic-private-auth-path";
const readRoutes = [
  ["POST", "/tools/list"], ["POST", "/tools/call"],
  ["POST", "/wiki/get"], ["POST", "/wiki/list"],
  ["POST", "/wiki/raw/ls"], ["POST", "/wiki/raw/read"],
  ["POST", "/wiki/page/ls"], ["POST", "/wiki/page/read"],
  ["POST", "/wiki/graph"], ["POST", "/wiki/search"],
  ["POST", "/code-graph/list"], ["POST", "/code-graph/get"],
  ["GET", "/source-credential/status"], ["GET", "/auto-sync/status"],
  ["GET", "/source-provider"], ["GET", "/source-provider/code"], ["GET", "/source-provider/wiki"],
] as const;
let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warnings = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

function setup(serviceKey = key, prefix = "/v3", readBody = false) {
  const app = new Hono();
  for (const path of ["/health", "/docs", "/openapi.json"]) app.get(path, (c) => c.json({ public: true }));
  const api = new Hono();
  api.use("*", createServiceAuthMiddleware({ serviceKey }, prefix));
  api.all("*", async (c) => c.json({ private: marker, body: readBody ? await c.req.json() : null }));
  app.route(prefix, api);
  return app;
}
async function rejected(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ code: 401, message: "unauthorized: valid service key required", data: null });
}

describe("Configured Knowledge service-key boundary", () => {
  it.each([...readRoutes, ["POST", "/wiki/create"], ["POST", "/internal/llm-binding/status"]] as const)(
    "requires the configured key for %s %s", async (method, route) => {
      await rejected(await setup().request("/v3" + route, { method }));
    });

  it("requires the key under a custom API prefix", async () => {
    await rejected(await setup(key, "/custom/api").request("/custom/api/wiki/get", { method: "POST" }));
  });

  it("rejects an incorrect key on a read endpoint", async () => {
    await rejected(await setup().request("/v3/wiki/get", { method: "POST", headers: { authorization: "Bearer wrong-key" } }));
  });

  it("does not treat caller-supplied scope selectors as authentication", async () => {
    await rejected(await setup().request("/v3/wiki/get", { method: "POST", headers: {
      "x-tdai-service-id": marker, "content-type": "application/json",
    }, body: JSON.stringify({ team_id: marker, user_id: marker, wiki_id: marker }) }));
  });

  it("rejects before an endpoint reads a private request stream", async () => {
    let pulls = 0;
    const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode(JSON.stringify({ private: marker }))); c.close(); } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    await rejected(await setup(key, "/v3", true).fetch(new Request("http://localhost/v3/wiki/get", init)));
    expect(pulls).toBe(0);
  });

  it.each(["/wiki/get", "/wiki/create"])("preserves authorized requests to %s", async (route) => {
    const response = await setup().request("/v3" + route, { method: "POST", headers: { authorization: "Bearer " + key } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ private: marker, body: null });
  });

  it("preserves the explicit empty-key compatibility policy", async () => {
    expect((await setup("").request("/v3/wiki/get", { method: "POST" })).status).toBe(200);
  });

  it.each(["/health", "/docs", "/openapi.json"])("leaves the separately mounted public route %s accessible", async (path) => {
    const response = await setup().request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ public: true });
  });

  it.each(["/v3", "/custom/api"])("omits private rejection paths under %s from diagnostics", async (prefix) => {
    await rejected(await setup(key, prefix).request(`${prefix}/${marker}?query=${marker}`, {
      method: "POST", headers: { authorization: `Bearer wrong-${marker}`, "content-type": "application/json" },
      body: JSON.stringify({ private: marker }),
    }));
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(marker);
  });
});
