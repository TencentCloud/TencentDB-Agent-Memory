import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { HttpKnowledgeClient } from "../../src/panel/kernel/adapters/http-knowledge-client.js";
import { CoreUpstreamError } from "../../src/panel/domain/errors.js";

describe("HttpKnowledgeClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: HttpKnowledgeClient;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    client = new HttpKnowledgeClient({
      baseUrl: "http://core:8421",
      authToken: "panel-secret-token",
      serviceId: "tenant-123"
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("forwards authToken as Bearer and serviceId as x-tdai-service-id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { wiki_id: "w-123", name: "test-wiki" } }),
    } as any);

    const result = await client.wikiGet("w-123");

    expect(result).toEqual({ wiki_id: "w-123", name: "test-wiki" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://core:8421/v3/wiki/get");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer panel-secret-token",
      "x-tdai-service-id": "tenant-123"
    });
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ wiki_id: "w-123" });
  });

  it("throws CoreUpstreamError on non-zero response code", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 401, message: "Invalid token" }),
    } as any);

    await expect(client.wikiGet("w-123")).rejects.toThrow(CoreUpstreamError);
    await expect(client.wikiGet("w-123")).rejects.toThrow("Invalid token");
  });
});
