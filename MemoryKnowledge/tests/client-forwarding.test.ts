import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { callApi } from "../src/mcp/http-client.js";

describe("MCP callApi client token forwarding", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("forwards the token as a Bearer authorization header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { success: true } }),
    } as any);

    const result = await callApi(
      { baseUrl: "http://localhost:8421", token: "test-secret-token" },
      "/wiki/page/read",
      { knowledge_id: "w-123" }
    );

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8421/v3/wiki/page/read");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer test-secret-token",
    });
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ knowledge_id: "w-123" });
  });

  it("omits the Authorization header when no token is provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { no_token: true } }),
    } as any);

    await callApi(
      { baseUrl: "http://localhost:8421" },
      "/wiki/list",
      {}
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("throws an error when response code is non-zero", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, message: "Unauthorized", data: null }),
    } as any);

    await expect(
      callApi({ baseUrl: "http://localhost:8421", token: "wrong" }, "/wiki/page/read", {})
    ).rejects.toThrow("Unauthorized");
  });

  it("forwards serviceId as x-tdai-service-id header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { items: [] } }),
    } as any);

    const result = await callApi(
      { baseUrl: "http://localhost:8421", serviceId: "service-tenant-alpha" },
      "/wiki/page/ls",
      { wiki_id: "w-123" }
    );

    expect(result).toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8421/v3/wiki/page/ls");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-tdai-service-id": "service-tenant-alpha",
    });
  });

  it("forwards both token and serviceId together", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { items: [] } }),
    } as any);

    await callApi(
      { baseUrl: "http://localhost:8421", token: "bearer-token-123", serviceId: "service-tenant-beta" },
      "/wiki/page/ls",
      { wiki_id: "w-456" }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer bearer-token-123",
      "x-tdai-service-id": "service-tenant-beta",
    });
  });

  it("throws an error when serviceId contains invalid characters", async () => {
    await expect(
      callApi({ baseUrl: "http://localhost:8421", serviceId: "../traversal" }, "/wiki/page/ls", {})
    ).rejects.toThrow(/Invalid serviceId/);
  });
});
