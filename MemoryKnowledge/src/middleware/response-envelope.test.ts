import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => logger,
}));

import { accessLog } from "./response-envelope.js";

describe("accessLog", () => {
  it("keeps a JSON request body readable by downstream handlers", async () => {
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/echo", async (c) => {
      return c.json({ received: await c.req.json() });
    });

    const response = await app.request("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki_id: "wiki-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: { wiki_id: "wiki-1" },
    });
  });

  it("preserves an error response after logging its body", async () => {
    const app = new Hono();
    app.use("*", accessLog());
    app.post("/fail", async (c) => {
      const body = await c.req.json();
      return c.json({ code: 400, data: body }, 400);
    });

    const response = await app.request("/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki_id: "wiki-2" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: 400,
      data: { wiki_id: "wiki-2" },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "POST /fail error",
      expect.objectContaining({ status: 400, wiki_id: "wiki-2" }),
    );
  });
});
