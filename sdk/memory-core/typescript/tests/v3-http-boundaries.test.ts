import { afterEach, describe, expect, it, vi } from "vitest";
import { ParamError } from "../src/errors.js";
import { V3HttpTransport } from "../src/v3/http.js";

const options = { endpoint: "https://memory.example.test///", apiKey: "gateway-key", serviceId: "space-a" };

function response(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), init);
}

function stubFetch(result: Response) {
  const fetch = vi.fn().mockResolvedValue(result);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("v3 transport configuration", () => {
  it.each(["not a URL", "file:///tmp/memory", "ftp://memory.example.test"])(
    "rejects endpoint %s", (endpoint) => {
      expect(() => new V3HttpTransport({ ...options, endpoint })).toThrow(ParamError);
    },
  );

  it.each([0, -1, Infinity, NaN])("rejects invalid timeout %s", (timeout) => {
    expect(() => new V3HttpTransport({ ...options, timeout })).toThrow(ParamError);
  });

  it.each(["apiKey", "serviceId"])("rejects blank %s", (field) => {
    expect(() => new V3HttpTransport({ ...options, [field]: "  " })).toThrow(ParamError);
  });
});

describe("v3 HTTP request and response boundary", () => {
  it("sends the tenant and user credentials, unwraps data and propagates tracing", async () => {
    const fetch = stubFetch(response({ code: 0, data: { count: 3 } }, { headers: { "x-trace-id": "trace-a" } }));
    const http = new V3HttpTransport({ ...options, userKey: "user-key" });
    await expect(http.post("/v3/conversation/count", { team_id: "team-a" }))
      .resolves.toEqual({ count: 3, trace_id: "trace-a" });
    expect(fetch).toHaveBeenCalledWith("https://memory.example.test/v3/conversation/count", {
      method: "POST",
      headers: {
        Authorization: "Bearer gateway-key", "x-tdai-service-id": "space-a",
        "x-tdai-user-key": "user-key", "Content-Type": "application/json",
      },
      body: JSON.stringify({ team_id: "team-a" }), signal: expect.any(AbortSignal),
    });
  });

  it("encodes GET queries, preserves false and zero, and omits undefined", async () => {
    const fetch = stubFetch(response({ code: 0, data: {} }));
    await new V3HttpTransport(options).get("/v3/metadata", {
      query: "team & user", offset: 0, enabled: false, absent: undefined,
    });
    expect(fetch.mock.calls[0][0]).toBe("https://memory.example.test/v3/metadata?query=team+%26+user&offset=0&enabled=false");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("preserves business error details needed for stale-version recovery", async () => {
    stubFetch(response({ code: 40901, message: "stale version", request_id: "body-request", data: { current_version: 2 } }, {
      status: 409, headers: { "x-qcloud-transaction-id": "header-request", "x-trace-id": "trace-a" },
    }));
    await expect(new V3HttpTransport(options).post("/v3/skill/update"))
      .rejects.toMatchObject({
        name: "TDAMError", code: 40901, requestId: "header-request", details: { current_version: 2 },
      });
  });

  it("treats an HTTP failure as an error even if the JSON reports success", async () => {
    stubFetch(response({ code: 0, message: "gateway failure" }, { status: 503 }));
    await expect(new V3HttpTransport(options).post("/v3/core/read")).rejects.toMatchObject({ code: 503 });
  });

  it("falls back to the response request ID for business failures", async () => {
    stubFetch(response({ code: 40301, message: "denied", request_id: "request-a" }));
    await expect(new V3HttpTransport(options).post("/v3/core/read"))
      .rejects.toMatchObject({ code: 40301, requestId: "request-a" });
  });

  it.each([200, 502])("wraps a non-JSON response (HTTP %i) in TDAMError", async (status) => {
    stubFetch(new Response("upstream unavailable", { status, headers: { "x-trace-id": "trace-a" } }));
    await expect(new V3HttpTransport(options).post("/v3/core/read"))
      .rejects.toMatchObject({ name: "TDAMError", code: status === 200 ? -1 : status, requestId: "trace-a" });
  });

  it.each([null, [], "success", 42, true].map((envelope) => ({ envelope })))(
    "rejects a non-object JSON envelope: $envelope", async ({ envelope }) => {
    stubFetch(response(envelope, { headers: { "x-trace-id": "trace-a" } }));
    await expect(new V3HttpTransport(options).post("/v3/core/read"))
      .rejects.toMatchObject({ name: "TDAMError", code: -1, requestId: "trace-a" });
  });

  it("retains the failing HTTP status when the JSON envelope is invalid", async () => {
    stubFetch(response(null, { status: 502, headers: { "x-trace-id": "trace-a" } }));
    await expect(new V3HttpTransport(options).post("/v3/core/read"))
      .rejects.toMatchObject({ name: "TDAMError", code: 502, requestId: "trace-a" });
  });

  it("allows an empty successful payload and primitive data with trace headers", async () => {
    const http = new V3HttpTransport(options);
    const fetch = stubFetch(response({ code: 0 }));
    await expect(http.post("/v3/core/read")).resolves.toEqual({});
    fetch.mockResolvedValueOnce(response({ code: 0, data: 3 }, { headers: { "x-trace-id": "trace-a" } }));
    await expect(http.post("/v3/core/count")).resolves.toBe(3);
  });

  it("aborts a timed-out request and clears its timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));
    const request = new V3HttpTransport({ ...options, timeout: 20 }).post("/v3/core/read");
    const assertion = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timeout resources after success and network errors", async () => {
    vi.useFakeTimers();
    const fetch = stubFetch(response({ code: 0, data: {} }));
    const http = new V3HttpTransport(options);
    await http.post("/v3/core/read");
    expect(vi.getTimerCount()).toBe(0);
    const networkError = new TypeError("network disconnected");
    fetch.mockRejectedValueOnce(networkError);
    await expect(http.post("/v3/core/read")).rejects.toBe(networkError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
