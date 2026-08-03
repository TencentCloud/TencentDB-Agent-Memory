import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../src/http.js";

const originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

afterEach(() => {
  if (originalTlsSetting === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsSetting;
  }
  vi.unstubAllGlobals();
});

describe("HttpTransport TLS scope", () => {
  it("uses a request-local dispatcher without mutating process TLS settings", async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "ok", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport({
      endpoint: "https://memory.example.test",
      apiKey: "key",
      serviceId: "service",
    });

    await transport.post("/v2/test");

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1");
    const request = fetchMock.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: { close(): Promise<void> } })
      | undefined;
    expect(request?.dispatcher).toBeDefined();
    await request?.dispatcher?.close();
  });

  it("omits the custom dispatcher when certificate verification is enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, message: "ok", data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport({
      endpoint: "https://memory.example.test",
      apiKey: "key",
      serviceId: "service",
      rejectUnauthorized: true,
    });

    await transport.post("/v2/test");

    const request = fetchMock.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(request?.dispatcher).toBeUndefined();
  });
});
