import { afterEach, describe, expect, it, vi } from "vitest";

import { callApi } from "./http-client.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("callApi", () => {
  it("aborts a stalled request after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        if (!init?.signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const request = callApi(
      { baseUrl: "http://knowledge.test", timeoutMs: 25 },
      "/wiki/search",
      { query: "memory" },
    );
    const rejection = expect(request).rejects.toThrow(
      "API request timed out after 25ms: /wiki/search",
    );
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("clears the deadline after a successful response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      message: "ok",
      data: { items: [] },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(
      callApi(
        { baseUrl: "http://knowledge.test", timeoutMs: 25 },
        "/wiki/search",
        { query: "memory" },
      ),
    ).resolves.toEqual({ items: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
