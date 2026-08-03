import { afterEach, describe, expect, it, vi } from "vitest";
import { TDAMError } from "../src/errors.js";
import { V3HttpTransport } from "../src/v3/http.js";

const transport = new V3HttpTransport({
  endpoint: "https://memory.example.test",
  apiKey: "api-key",
  serviceId: "default",
});

function response(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("V3HttpTransport response envelopes", () => {
  it("rejects a non-object response envelope as a protocol error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([])));

    await expect(transport.post("/v3/test")).rejects.toMatchObject<TDAMError>({
      code: -1,
      message: expect.stringContaining("API response must be a JSON object"),
    });
  });

  it("uses a protocol error code when a successful envelope omits code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ message: "ok", data: {} })),
    );

    await expect(transport.post("/v3/test")).rejects.toMatchObject<TDAMError>({
      code: -1,
    });
  });

  it("rejects primitive success data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          code: 0,
          message: "ok",
          request_id: "request-1",
          data: "not-an-object",
        }),
      ),
    );

    await expect(transport.post("/v3/test")).rejects.toMatchObject<TDAMError>({
      code: -1,
      message: expect.stringContaining("API response data must be a JSON object"),
    });
  });

  it("preserves object data and response trace ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            code: 0,
            message: "ok",
            request_id: "request-1",
            data: { value: 1 },
          },
          { "x-trace-id": "trace-1" },
        ),
      ),
    );

    await expect(transport.post("/v3/test")).resolves.toEqual({
      value: 1,
      trace_id: "trace-1",
    });
  });
});
