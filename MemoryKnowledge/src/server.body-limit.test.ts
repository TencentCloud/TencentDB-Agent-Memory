import { describe, it, expect } from "vitest";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { resolveKnowledgeMaxBodyBytes } from "./api-helpers.js";
import { wrapError } from "./api-helpers.js";

describe("resolveKnowledgeMaxBodyBytes", () => {
  it("defaults to 16 MiB, honors valid override, falls back on invalid", () => {
    expect(resolveKnowledgeMaxBodyBytes(undefined)).toBe(16 * 1024 * 1024);
    expect(resolveKnowledgeMaxBodyBytes("1024")).toBe(1024);
    expect(resolveKnowledgeMaxBodyBytes("bogus")).toBe(16 * 1024 * 1024);
    expect(resolveKnowledgeMaxBodyBytes("-1")).toBe(16 * 1024 * 1024);
  });
});

describe("bodyLimit wiring (same middleware as the /v3 api sub-app)", () => {
  it("rejects oversized bodies with 413 wrapError envelope", async () => {
    const app = new Hono();
    app.use("*", bodyLimit({
      maxSize: 10,
      onError: (c) => c.json(wrapError(413, "request body too large"), 413),
    }));
    app.post("/x", (c) => c.json({ ok: true }));

    const res = await app.request("/x", { method: "POST", body: "x".repeat(64) });
    expect(res.status).toBe(413);
    const body = await res.json() as { message?: string; error?: { message?: string } };
    expect(JSON.stringify(body)).toContain("request body too large");
  });
});
