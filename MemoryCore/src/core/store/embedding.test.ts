import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIEmbeddingService } from "./embedding.js";

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function capture<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

describe("OpenAIEmbeddingService retries", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const service = () =>
    new OpenAIEmbeddingService({
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "https://embedding.test/v1",
      model: "test-model",
      dimensions: 2,
      timeoutMs: 100,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a 503 response and returns the eventual embedding", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(successResponse());

    const outcomePromise = capture(service().embedBatch(["hello"]));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries HTTP 429 rate limits", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("slow down", { status: 429, statusText: "Too Many Requests" }))
      .mockResolvedValueOnce(successResponse());

    const outcomePromise = capture(service().embedBatch(["hello"]));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries request timeouts", async () => {
    fetchMock
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        }),
      )
      .mockResolvedValueOnce(successResponse());

    const outcomePromise = capture(service().embedBatch(["hello"]));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient network failures", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(successResponse());

    const outcomePromise = capture(service().embedBatch(["hello"]));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits 500ms before the first retry", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(successResponse());

    const outcomePromise = capture(service().embedBatch(["hello"]));
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const outcome = await outcomePromise;
    expect(outcome.error).toBeUndefined();
  });

  it("stops after two retries when the provider remains unavailable", async () => {
    fetchMock.mockResolvedValue(
      new Response("still unavailable", { status: 503, statusText: "Service Unavailable" }),
    );

    const outcomePromise = capture(service().embedBatch(["hello"]));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;
    expect(String(outcome.error)).toMatch(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-rate-limited 4xx responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("bad request", { status: 400, statusText: "Bad Request" }),
    );

    const outcome = await capture(service().embedBatch(["hello"]));
    expect(String(outcome.error)).toMatch(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
