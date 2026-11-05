import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initAuth } from "../auth.js";
import { authorizeBridgeSession } from "../bridge-auth.js";

const config = { enabled: true, url: "http://auth.test", timeoutMs: 100,
  requireBridgeUserKey: true };

afterEach(() => {
  vi.unstubAllGlobals();
  initAuth({ ...config, enabled: false });
});

function app(strict = true) {
  const app = new Hono();
  app.post("/", async c => await authorizeBridgeSession(c,
    { ...config, requireBridgeUserKey: strict },
    { user_id: "project-a", space_id: "session-instance" }, "untrusted-instance")
    ?? c.json({ code: 0 }));
  return app;
}

function mockUser(userId: string) {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 0,
    data: { valid: true, user: { user_id: userId } } }));
  vi.stubGlobal("fetch", fetcher);
  initAuth(config);
  return fetcher;
}

describe("bridge session owner authentication", () => {
  it("preserves legacy callers only when strict mode is disabled", async () => {
    expect((await app(false).request("/", { method: "POST" })).status).toBe(200);
  });

  it("requires a key", async () => {
    const fetcher = mockUser("project-a");
    expect((await app().request("/", { method: "POST" })).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["x-tdai-user-key", "authorization"])("accepts the verified owner via %s", async header => {
    const fetcher = mockUser("project-a");
    const value = header === "authorization" ? "Bearer fixture-key" : "fixture-key";
    expect((await app().request("/", { method: "POST", headers: { [header]: value } })).status).toBe(200);
    expect(fetcher.mock.calls[0][1].headers["x-tdai-service-id"]).toBe("session-instance");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ user_key: "fixture-key" });
  });

  it("rejects another project's user, even with forged body identity", async () => {
    mockUser("project-b");
    const response = await app().request("/", { method: "POST",
      headers: { "x-tdai-user-key": "other-project" }, body: JSON.stringify({ user_id: "project-a" }) });
    expect(response.status).toBe(403);
  });

  it.each(["invalid", "unavailable", "empty-user"])("fails closed: %s", async failure => {
    initAuth(config);
    vi.stubGlobal("fetch", failure === "unavailable" ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(Response.json({ code: 0,
        data: { valid: failure !== "invalid", user: { user_id: "" } } })));
    expect((await app().request("/", { method: "POST",
      headers: { "x-tdai-user-key": "fixture-key" } })).status).toBe(401);
  });

  it("does not silently bypass when auth is uninitialized", async () => {
    initAuth({ ...config, enabled: false });
    expect((await app().request("/", { method: "POST",
      headers: { "x-tdai-user-key": "fixture-key" } })).status).toBe(401);
  });
});
