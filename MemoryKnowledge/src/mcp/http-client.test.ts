/**
 * Regression tests for the MCP HTTP client (issue #766).
 *
 * `callApi()` sent only `Content-Type` and an optional bearer token, never
 * the `x-tdai-service-id` header that every `/v3` route requires. Since the
 * value cannot be supplied in the request body (the tool schemas are strict
 * and reject unknown fields), the bundled MCP server as published could not
 * complete a single call against its own HTTP API.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { callApi, type HttpClientOptions } from "./http-client.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Capture the outgoing request and answer with an ok envelope. */
function captureRequest(): { captured: () => CapturedRequest | undefined } {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
    });
    return {
      status: 200,
      json: async () => ({ code: 0, message: "ok", data: { request_id: "r-1" } }),
    } as Response;
  }) as never);
  return { captured: () => requests[0] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const opts = (extra: Partial<HttpClientOptions> = {}): HttpClientOptions => ({
  baseUrl: "http://knowledge.test:8421",
  ...extra,
});

describe("MCP http-client service id", () => {
  it("sends x-tdai-service-id when a service id is configured", async () => {
    const { captured } = captureRequest();

    await callApi(opts({ serviceId: "default" }), "/wiki/search", { team_id: "t-1" });

    expect(captured()?.headers["x-tdai-service-id"]).toBe("default");
  });

  it("sends the configured service id, not a hard-coded one", async () => {
    const { captured } = captureRequest();

    await callApi(opts({ serviceId: "svc-42" }), "/code-graph/status", { team_id: "t-1" });

    expect(captured()?.headers["x-tdai-service-id"]).toBe("svc-42");
  });

  it("keeps the bearer token alongside the service id", async () => {
    const { captured } = captureRequest();

    await callApi(
      opts({ token: "k-123", serviceId: "default" }),
      "/wiki/search",
      { team_id: "t-1" },
    );

    expect(captured()?.headers).toMatchObject({
      Authorization: "Bearer k-123",
      "x-tdai-service-id": "default",
    });
  });

  it("omits the header when no service id is configured", async () => {
    const { captured } = captureRequest();

    await callApi(opts(), "/wiki/search", { team_id: "t-1" });

    // Preserves the previous behaviour: no service id → no header. The API
    // answers 400 "x-tdai-service-id header is required", which is the
    // operator's configuration problem to fix.
    expect(captured()?.headers["x-tdai-service-id"]).toBeUndefined();
  });

  it("still targets the /v3 endpoints", async () => {
    const { captured } = captureRequest();

    await callApi(opts({ serviceId: "default" }), "/wiki/search", { team_id: "t-1" });

    expect(captured()?.url).toBe("http://knowledge.test:8421/v3/wiki/search");
  });
});
