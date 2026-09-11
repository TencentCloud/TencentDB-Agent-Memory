import { afterEach, describe, expect, it, vi } from "vitest";
import { V3HttpTransport } from "../src/v3/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(["get", "post"] as const)("V3HttpTransport.%s", (method) => {
  const transport = new V3HttpTransport({
    endpoint: "https://memory.example.com",
    apiKey: "test-api-key",
    serviceId: "test-service-id",
  });

  function mockResponse(body: string, status = 200, headers: Record<string, string> = {}) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status, headers })));
  }

  it.each(["null", "[]", '"unexpected"', "42", "true"])(
    "rejects a non-object JSON envelope: %s",
    async (body) => {
      mockResponse(body, 200, { "x-trace-id": "trace-invalid-envelope" });

      await expect(transport[method]("/v3/test")).rejects.toMatchObject({
        name: "TDAMError",
        code: -1,
        message: expect.stringContaining("API response must be a JSON object"),
        requestId: "trace-invalid-envelope",
      });
    },
  );

  it("preserves the HTTP status and transaction ID for an invalid error envelope", async () => {
    mockResponse("null", 502, {
      "x-qcloud-transaction-id": "transaction-error",
      "x-trace-id": "trace-error",
    });

    await expect(transport[method]("/v3/test")).rejects.toMatchObject({
      name: "TDAMError",
      code: 502,
      requestId: "transaction-error",
    });
  });

  it("returns valid data with its trace ID", async () => {
    mockResponse(JSON.stringify({ code: 0, data: { items: [] } }), 200, {
      "x-trace-id": "trace-success",
    });

    await expect(transport[method]("/v3/test")).resolves.toEqual({
      items: [],
      trace_id: "trace-success",
    });
  });

  it("continues to accept successful envelopes without data", async () => {
    mockResponse(JSON.stringify({ code: 0 }));

    await expect(transport[method]("/v3/test")).resolves.toEqual({});
  });

  it("preserves business error details and the envelope request ID", async () => {
    mockResponse(JSON.stringify({
      code: 40901,
      message: "Skill version is stale",
      request_id: "request-conflict",
      data: { current_version: 2 },
    }));

    await expect(transport[method]("/v3/test")).rejects.toMatchObject({
      name: "TDAMError",
      code: 40901,
      message: expect.stringContaining("Skill version is stale"),
      requestId: "request-conflict",
      details: { current_version: 2 },
    });
  });
});
