/** Tests for TdaiHttpClient 鈥?uses mock fetch to avoid Gateway dependency. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TdaiHttpClient, TdaiConnectionError, TdaiAuthError, TdaiRateLimitError, TdaiTimeoutError, TdaiValidationError, TdaiNotFoundError } from "./tdai-http-client.js";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(status: number, body: unknown, ok?: boolean) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: ok ?? (status >= 200 && status < 300),
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("TdaiHttpClient", () => {
  beforeEach(() => { mockFetch(200, { status: "ok", uptime: 123, stores: { l0: "ready" } }); });
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it("health returns gateway status", async () => {
    const client = new TdaiHttpClient();
    const h = await client.health();
    expect(h.status).toBe("ok");
    expect(h.uptime).toBe(123);
  });

  it("addConversation posts to correct endpoint", async () => {
    const client = new TdaiHttpClient();
    await client.addConversation("sess-1", [{ role: "user", content: "hi" }]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v2/conversation/add"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("searchAtomic posts query", async () => {
    const client = new TdaiHttpClient();
    await client.searchAtomic("test query", 3);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v2/atomic/search"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("test query"),
      }),
    );
  });

  it("sets auth header when apiKey provided", async () => {
    const client = new TdaiHttpClient({ apiKey: "sk-test" });
    await client.health();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
  });

  it("throws TdaiAuthError on 401", async () => {
    mockFetch(401, { error: "unauthorized" }, false);
    const client = new TdaiHttpClient({ apiKey: "bad" });
    await expect(client.health()).rejects.toThrow(TdaiAuthError);
  });

  it("throws TdaiRateLimitError on 429", async () => {
    mockFetch(429, { error: "rate limited" }, false);
    const client = new TdaiHttpClient();
    await expect(client.health()).rejects.toThrow(TdaiRateLimitError);
  });

  it("throws TdaiValidationError on 400", async () => {
    mockFetch(400, { error: "bad request" }, false);
    const client = new TdaiHttpClient();
    await expect(client.searchAtomic("", 0)).rejects.toThrow(TdaiValidationError);
  });

  it("throws TdaiNotFoundError on 404", async () => {
    mockFetch(404, { error: "not found" }, false);
    const client = new TdaiHttpClient();
    await expect(client.health()).rejects.toThrow(TdaiNotFoundError);
  });

  it("throws TdaiConnectionError on 503", async () => {
    mockFetch(503, "service unavailable", false);
    const client = new TdaiHttpClient();
    await expect(client.health()).rejects.toThrow(TdaiConnectionError);
  });

  it("uses env vars for defaults", async () => {
    process.env.TDAI_ENDPOINT = "http://localhost:9999";
    process.env.TDAI_API_KEY = "env-key";
    const client = new TdaiHttpClient();
    await client.health();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9999/health",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env-key" }),
      }),
    );
    delete process.env.TDAI_ENDPOINT;
    delete process.env.TDAI_API_KEY;
  });
});
