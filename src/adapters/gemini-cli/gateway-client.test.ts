import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayClientOptions, TdaiGatewayClient } from "./gateway-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveGatewayClientOptions", () => {
  it("defaults to the local gateway", () => {
    const options = resolveGatewayClientOptions({});
    expect(options.baseUrl).toBe("http://127.0.0.1:8420");
    expect(options.apiKey).toBeUndefined();
  });

  it("prefers MEMORY_TENCENTDB_GATEWAY_* names", () => {
    const options = resolveGatewayClientOptions({
      MEMORY_TENCENTDB_GATEWAY_HOST: "10.0.0.5",
      MEMORY_TENCENTDB_GATEWAY_PORT: "9999",
      MEMORY_TENCENTDB_GATEWAY_API_KEY: " sk-test ",
      MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS: "1200",
    });
    expect(options.baseUrl).toBe("http://10.0.0.5:9999");
    expect(options.apiKey).toBe("sk-test");
    expect(options.timeoutMs).toBe(1200);
  });

  it("accepts an explicit gateway URL", () => {
    const options = resolveGatewayClientOptions({ TDAI_GATEWAY_URL: "http://localhost:9000/" });
    expect(options.baseUrl).toBe("http://localhost:9000/");
  });
});

describe("TdaiGatewayClient", () => {
  it("posts recall with auth and parses the response", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ context: "remembered", strategy: "hybrid", memory_count: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TdaiGatewayClient({
      baseUrl: "http://gateway.example:8420/",
      apiKey: " sk-test ",
    });
    const result = await client.recall({ query: "hello", sessionKey: "s1" });

    expect(result.context).toBe("remembered");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gateway.example:8420/recall");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    expect(JSON.parse(String(init.body))).toEqual({ query: "hello", session_key: "s1" });
  });
});
