import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "../src/middleware/error-handler.js";

const marker = "synthetic-private-exception-path";
function capture() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}
afterEach(() => vi.restoreAllMocks());

describe("Knowledge exception-log privacy", () => {
  it("omits matched caller path values and exception details while keeping a generic 500", async () => {
    const log = capture();
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/private/:id", () => { throw new Error(marker); });
    const response = await app.request(`/private/${marker}?token=${marker}`, {
      headers: { Authorization: `Bearer ${marker}` },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 500, message: "Internal Server Error", data: null });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
  });

  it("omits unmatched paths when global middleware fails", async () => {
    const log = capture();
    const app = new Hono();
    app.onError(errorHandler);
    app.use("*", () => { throw new Error(marker); });
    const response = await app.request(`/unknown/${marker}`);
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
  });

  it("omits caller paths when an error occurs in a mounted router", async () => {
    const log = capture();
    const child = new Hono();
    child.get("/:id", () => { throw new Error(marker); });
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/mounted", child);
    const response = await app.request(`/mounted/${marker}`);
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
  });

  it("preserves malformed JSON handling without logging the request or parser detail", async () => {
    const log = capture();
    const app = new Hono();
    app.onError(errorHandler);
    app.post("/parse/:id", async (c) => c.json(await c.req.json()));
    const response = await app.request(`/parse/${marker}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: `{"${marker}":` });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 400, message: "malformed JSON", data: null });
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps other SyntaxErrors generic rather than exposing their messages", async () => {
    const log = capture();
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/syntax", () => { throw new SyntaxError(marker); });
    const response = await app.request("/syntax");
    expect(response.status).toBe(500);
    expect((await response.json()).message).toBe("Internal Server Error");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
  });
});
