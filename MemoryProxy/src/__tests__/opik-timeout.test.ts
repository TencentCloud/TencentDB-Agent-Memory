import { afterEach, describe, expect, it, vi } from "vitest";
import {
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
} from "../opik.js";
import type { ProxyConfig } from "../types.js";

const config = {
  opik: {
    enabled: true,
    url: "https://opik.example.test",
    apiKey: "",
    stripRequestLogContent: false,
  },
} as ProxyConfig;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Opik request deadlines", () => {
  it("bounds every fire-and-forget request", () => {
    const signals: AbortSignal[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const signal = new AbortController().signal;
      signals.push(signal);
      return signal;
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    opikCreateTrace(config, {
      traceId: "trace-1",
      projectName: "project",
      name: "request",
      startTime: "2026-08-03T00:00:00.000Z",
      input: {},
    });
    opikUpdateTrace(config, {
      traceId: "trace-1",
      projectName: "project",
      endTime: "2026-08-03T00:00:01.000Z",
      output: {},
      usage: {},
    });
    opikCreateLlmSpan(config, {
      traceId: "trace-1",
      projectName: "project",
      name: "completion",
      startTime: "2026-08-03T00:00:00.000Z",
      endTime: "2026-08-03T00:00:01.000Z",
      inputMessages: [],
      outputMessage: null,
      model: "test-model",
      usage: {},
    });

    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 10_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 10_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(3, 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      expect(call[1]?.signal).toBe(signals[index]);
    }
  });
});
