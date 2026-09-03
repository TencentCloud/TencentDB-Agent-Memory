import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDshFilesEndpoint,
  resolveDshFilesUpstreamUrl,
} from "../dshFilesHandler.js";
import type { ProxyConfig } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveDshFilesUpstreamUrl", () => {
  it("appends files to an API base", () => {
    expect(resolveDshFilesUpstreamUrl("https://api.deepseek.com/v1"))
      .toBe("https://api.deepseek.com/v1/files");
  });

  it("replaces a configured chat-completions endpoint", () => {
    expect(resolveDshFilesUpstreamUrl(
      "https://tokenhub.example.com/v2/chat/completions",
      "file/id",
    )).toBe("https://tokenhub.example.com/v2/files/file%2Fid");
  });

  it("preserves list query parameters", () => {
    expect(resolveDshFilesUpstreamUrl(
      "https://api.deepseek.com/v1/",
      undefined,
      "?after=file-1&limit=20",
    )).toBe("https://api.deepseek.com/v1/files?after=file-1&limit=20");
  });
});

describe("handleDshFilesEndpoint", () => {
  it("forwards multipart uploads with the configured dsh upstream key", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: "file-upstream-1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const config = {
      server: { forwardTimeoutMs: 5_000 },
      upstream: {
        url: "https://fallback.example.com/v1",
        apiKey: "fallback-key",
        agents: {
          dsh: { url: "https://dsh.example.com/v1", apiKey: "dsh-upstream-key" },
        },
      },
    } as unknown as ProxyConfig;
    const app = new Hono();
    app.post("/dsh/:spaceId/files", (c) => handleDshFilesEndpoint(c, config));

    const response = await app.request("http://proxy.test/dsh/space-a/files", {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-user-key",
        "content-type": "multipart/form-data; boundary=test-boundary",
      },
      body: "--test-boundary--\r\n",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "file-upstream-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://dsh.example.com/v1/files");
    expect(options.method).toBe("POST");
    expect(new Headers(options.headers).get("authorization"))
      .toBe("Bearer dsh-upstream-key");
    expect(new Headers(options.headers).get("content-type"))
      .toContain("multipart/form-data");
  });

  it("forwards GET metadata without a request body", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      server: {},
      upstream: { url: "https://api.deepseek.com/v1", apiKey: "key", agents: {} },
    } as unknown as ProxyConfig;
    const app = new Hono();
    app.get("/dsh/:spaceId/files/:fileId", (c) => handleDshFilesEndpoint(c, config));

    await app.request("http://proxy.test/dsh/space-a/files/file-1", {
      headers: { authorization: "Bearer proxy-user-key" },
    });

    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/files/file-1");
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
  });
});
