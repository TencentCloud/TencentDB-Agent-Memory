/**
 * Tests for #766 — the MCP HTTP client must send the `x-tdai-service-id`
 * header (tenant identity) that every /v3 endpoint requires, otherwise every
 * MCP `tools/call` fails with 400.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { callApi } from "./http-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK = { code: 0, message: "ok", data: { id: 1 } };

describe("callApi (#766)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends x-tdai-service-id header when serviceId is provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, OK));
    vi.stubGlobal("fetch", fetchMock);

    const data = await callApi(
      { baseUrl: "http://localhost:8421", serviceId: "my-tenant" },
      "/wiki/search",
      { q: "x" },
    );
    expect(data).toEqual({ id: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8421/v3/wiki/search");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-tdai-service-id": "my-tenant",
    });
  });

  it("omits x-tdai-service-id when serviceId is absent (backward compatible)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, OK));
    vi.stubGlobal("fetch", fetchMock);

    await callApi({ baseUrl: "http://localhost:8421" }, "/wiki/search", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("x-tdai-service-id");
  });

  it("sends bearer token when provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, OK));
    vi.stubGlobal("fetch", fetchMock);

    await callApi({ baseUrl: "http://localhost:8421", token: "abc" }, "/wiki/search", {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer abc" });
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, OK));
    vi.stubGlobal("fetch", fetchMock);

    await callApi({ baseUrl: "http://localhost:8421/" }, "/wiki/search", {});
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8421/v3/wiki/search");
  });

  it("throws the server message on HTTP error status (e.g. missing service_id)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { code: 400, message: "x-tdai-service-id header is required", data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callApi({ baseUrl: "http://localhost:8421" }, "/wiki/search", {}),
    ).rejects.toThrow("x-tdai-service-id header is required");
  });

  it("throws on a non-zero business code", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { code: 1, message: "boom", data: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(callApi({ baseUrl: "http://localhost:8421" }, "/wiki/search", {})).rejects.toThrow(
      "boom",
    );
  });

  it("throws a descriptive error on invalid JSON response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(callApi({ baseUrl: "http://localhost:8421" }, "/wiki/search", {})).rejects.toThrow(
      /invalid JSON/,
    );
  });
});
