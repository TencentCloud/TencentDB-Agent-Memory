import { afterEach, describe, expect, it, vi } from "vitest";
import { callApi } from "./http-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("MCP knowledge HTTP client", () => {
  it("sends the configured instance identity and keeps bearer authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { results: ["SAL"] } })));
    vi.stubGlobal("fetch", fetchMock);
    const options = { baseUrl: "http://knowledge/", serviceId: "default", token: "test-token" };
    await expect(callApi(options, "/wiki/search", { wiki_id: "wiki-test", query: "SAL" })).resolves.toEqual({ results: ["SAL"] });
    expect(fetchMock).toHaveBeenCalledWith("http://knowledge/v3/wiki/search", expect.objectContaining({
      headers: expect.objectContaining({ "x-tdai-service-id": "default", Authorization: "Bearer test-token" }),
    }));
  });

  it.each(["", "../other", "a".repeat(201)])("rejects invalid instance identity before sending a request: %s", async (serviceId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(callApi({ baseUrl: "http://knowledge", serviceId }, "/wiki/search", {})).rejects.toThrow("KNOWLEDGE_API_SERVICE_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves API errors as tool failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 404, message: "wiki not found" }), { status: 404 })));
    await expect(callApi({ baseUrl: "http://knowledge", serviceId: "default" }, "/wiki/search", {})).rejects.toThrow("wiki not found");
  });
});
