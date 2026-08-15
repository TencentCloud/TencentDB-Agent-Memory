/**
 * Security tests for #672 (CWE-306) — /v3/admin/rate-limits must require the
 * admin.apiKey bearer token.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimitHandlers } from "../routes/rate-limits.js";

const cfg = {
  admin: { apiKey: "adminkey" },
  rateLimit: { tpm: 1000, qpm: 100 },
} as any;

describe("rate-limit admin endpoints require auth (#672)", () => {
  it("rejects an unauthenticated GET", async () => {
    const app = new Hono();
    app.get("/v3/admin/rate-limits", createRateLimitHandlers(cfg).get);
    const res = await app.request("/v3/admin/rate-limits");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated PUT / DELETE", async () => {
    const app = new Hono();
    const handlers = createRateLimitHandlers(cfg);
    app.put("/v3/admin/rate-limits", handlers.put);
    app.delete("/v3/admin/rate-limits", handlers.delete);

    expect((await app.request("/v3/admin/rate-limits", { method: "PUT" })).status).toBe(401);
    expect((await app.request("/v3/admin/rate-limits", { method: "DELETE" })).status).toBe(401);
  });

  it("passes auth through with a valid admin key", async () => {
    const app = new Hono();
    app.get("/v3/admin/rate-limits", createRateLimitHandlers(cfg).get);
    const res = await app.request("/v3/admin/rate-limits", {
      headers: { Authorization: "Bearer adminkey" },
    });
    // With a valid key the request reaches the handler — it must NOT be 401.
    expect(res.status).not.toBe(401);
  });
});
