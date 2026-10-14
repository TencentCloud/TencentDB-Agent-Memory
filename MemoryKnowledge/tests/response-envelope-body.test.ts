import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { accessLog } from "../src/middleware/response-envelope.js";

describe("access logging preserves Hono body readers", () => {
  for (const method of ["POST", "PUT"]) {
    for (const value of [{ value: "synthetic" }, false, 0, null]) {
      it(`${method} preserves repeated JSON, text and byte reads for ${JSON.stringify(value)}`, async () => {
        const app = new Hono();
        app.use("*", accessLog());
        app.on(method, "/", async (c) => {
          const text = await c.req.text();
          const first = await c.req.json();
          const second = await c.req.json();
          const bytes = await c.req.arrayBuffer();
          return c.json({ text, first, second, bytes: new TextDecoder().decode(bytes) });
        });
        const raw = JSON.stringify(value);
        const response = await app.request("/", { method, headers: { "content-type": "application/json" }, body: raw });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ text: raw, first: value, second: value, bytes: raw });
      });
    }
    it(`${method} preserves malformed JSON as text for downstream readers`, async () => {
      const app = new Hono();
      app.use("*", accessLog());
      app.on(method, "/", async (c) => {
        await expect(c.req.json()).rejects.toThrow();
        return c.text(await c.req.text());
      });
      const response = await app.request("/", { method, body: "synthetic malformed {" });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("synthetic malformed {");
    });
  }
});
