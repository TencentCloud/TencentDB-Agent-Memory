import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayClient } from "../../pi-plugin/tdai-memory/gateway-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(response: Response | Error): ReturnType<typeof vi.fn> {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GatewayClient request shape", () => {
  it("POSTs /recall with query and session_key", async () => {
    const fetchMock = mockFetch(jsonResponse({ context: "ctx", memory_count: 1 }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    const result = await client.recall("what language?", "pi_abc");

    expect(result).toEqual({ context: "ctx", memory_count: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://gw:8420/recall");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ query: "what language?", session_key: "pi_abc" });
  });

  it("POSTs /capture with the full round", async () => {
    const fetchMock = mockFetch(jsonResponse({ l0_recorded: 2, scheduler_notified: true }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    await client.capture("user says", "assistant says", "pi_abc");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://gw:8420/capture");
    expect(JSON.parse(init.body)).toEqual({
      user_content: "user says",
      assistant_content: "assistant says",
      session_key: "pi_abc",
    });
  });

  it("POSTs /search/memories and omits limit when not given", async () => {
    const fetchMock = mockFetch(jsonResponse({ results: "r", total: 0, strategy: "fts" }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    await client.searchMemories("rust");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ query: "rust" });

    await client.searchMemories("rust", 3);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ query: "rust", limit: 3 });
  });

  it("POSTs /session/end with session_key", async () => {
    const fetchMock = mockFetch(jsonResponse({ flushed: true }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    const result = await client.sessionEnd("pi_abc");

    expect(result).toEqual({ flushed: true });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://gw:8420/session/end");
  });

  it("strips trailing slashes from the base URL", async () => {
    const fetchMock = mockFetch(jsonResponse({ context: "" }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420///" });

    await client.recall("q", "s");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://gw:8420/recall");
  });
});

describe("GatewayClient auth", () => {
  it("sends Authorization: Bearer when apiKey is set", async () => {
    const fetchMock = mockFetch(jsonResponse({ context: "" }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420", apiKey: "sekrit" });

    await client.recall("q", "s");

    expect(fetchMock.mock.calls[0]![1].headers["Authorization"]).toBe("Bearer sekrit");
  });

  it("sends no Authorization header when apiKey is unset", async () => {
    const fetchMock = mockFetch(jsonResponse({ context: "" }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    await client.recall("q", "s");

    expect(fetchMock.mock.calls[0]![1].headers["Authorization"]).toBeUndefined();
  });
});

describe("GatewayClient fault tolerance", () => {
  it("returns null (never throws) when the gateway is unreachable", async () => {
    mockFetch(new TypeError("fetch failed: ECONNREFUSED"));
    const client = new GatewayClient({ baseUrl: "http://gw:9999" });

    await expect(client.recall("q", "s")).resolves.toBeNull();
    await expect(client.capture("u", "a", "s")).resolves.toBeNull();
    await expect(client.searchMemories("q")).resolves.toBeNull();
    await expect(client.sessionEnd("s")).resolves.toBeNull();
  });

  it("returns null on non-2xx responses and reports via onError", async () => {
    mockFetch(jsonResponse({ error: "Unauthorized" }, 401));
    const onError = vi.fn();
    const client = new GatewayClient({ baseUrl: "http://gw:8420", onError });

    const result = await client.recall("q", "s");

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith("/recall", expect.any(Error));
    expect(String(onError.mock.calls[0]![1])).toContain("401");
  });

  it("returns null on malformed JSON bodies", async () => {
    mockFetch(new Response("not json{", { status: 200 }));
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    await expect(client.recall("q", "s")).resolves.toBeNull();
  });

  it("aborts via the caller-provided signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GatewayClient({ baseUrl: "http://gw:8420" });

    const pending = client.recall("q", "s", controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();
  });
});
