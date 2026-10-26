import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { accessLog } from "../src/middleware/response-envelope.js";

const marker = "synthetic-private-source-path-and-key";
function logs() {
  return [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")]
    .map((spy) => spy.mockImplementation(() => {}));
}
function text(spies: ReturnType<typeof logs>) {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}
afterEach(() => vi.restoreAllMocks());

describe("Knowledge HTTP access-log privacy", () => {
  it("keeps arbitrary identifier fields and error bodies out of logs without changing the response", async () => {
    const captured = logs();
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/v3/wiki/read", async (c) => {
      const body = await c.req.json();
      expect(body).toEqual({ wiki_id: marker, path: marker, team_id: marker });
      return c.json({ code: 400, message: marker, data: { content: marker } }, 400);
    });
    const response = await app.request("/v3/wiki/read", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${marker}` },
      body: JSON.stringify({ wiki_id: marker, path: marker, team_id: marker }) });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe(marker);
    expect(text(captured)).not.toContain(marker);
    expect(text(captured)).toContain("400");
  });

  it("does not record private path parameters in a matched route", async () => {
    const captured = logs();
    const app = new Hono();
    app.use("*", accessLog());
    app.get("/v3/wiki/:wikiId", (c) => c.json({ id: c.req.param("wikiId") }));
    const response = await app.request(`/v3/wiki/${marker}`);
    expect(await response.json()).toEqual({ id: marker });
    expect(text(captured)).not.toContain(marker);
    expect(text(captured)).toContain("/v3/wiki/:wikiId");
  });

  it("does not record an unmatched private URL path", async () => {
    const captured = logs();
    const app = new Hono();
    app.use("*", accessLog());
    const response = await app.request(`/unknown/${marker}`);
    expect(response.status).toBe(404);
    expect(text(captured)).not.toContain(marker);
  });

  it("does not consume an error response stream before the caller reads it", async () => {
    const captured = logs();
    const app = new Hono();
    app.use("*", accessLog());
    let reads = 0;
    app.get("/v3/stream", () => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode(marker)); controller.close(); },
    }, { highWaterMark: 0 }), { status: 500 }));
    const response = await app.request("/v3/stream");
    expect(reads).toBe(0);
    expect(await response.text()).toBe(marker);
    expect(reads).toBe(1);
    expect(text(captured)).not.toContain(marker);
  });

  it("does not consume an unused POST body", async () => {
    logs();
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/v3/reject", (c) => c.json({ code: 400, message: "rejected" }, 400));
    let reads = 0;
    const body = new ReadableStream({ pull(controller) {
      reads++; controller.enqueue(new TextEncoder().encode(JSON.stringify({ content: marker }))); controller.close();
    } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const response = await app.fetch(new Request("http://localhost/v3/reject", init));
    expect(response.status).toBe(400);
    expect(reads).toBe(0);
  });

  it("preserves non-UTF8 error response bytes and headers", async () => {
    logs();
    const bytes = new Uint8Array([0xff, 0, 0xc3, 0x28, 0xfe]);
    const app = new Hono();
    app.use("*", accessLog());
    app.get("/v3/binary", () => new Response(bytes, { status: 400,
      headers: { "Content-Type": "application/octet-stream", "X-Synthetic": "retained" } }));
    const response = await app.request("/v3/binary");
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Synthetic")).toBe("retained");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("preserves request-id tracking and successful JSON body handling", async () => {
    const captured = logs();
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/v3/echo", async (c) => c.json({ body: await c.req.json(), requestId: c.get("requestId") }));
    const response = await app.request(`/v3/echo?query=${marker}`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": "synthetic-request-id" },
      body: JSON.stringify({ content: marker }) });
    expect(await response.json()).toEqual({ body: { content: marker }, requestId: "synthetic-request-id" });
    expect(text(captured)).not.toContain(marker);
  });
});
