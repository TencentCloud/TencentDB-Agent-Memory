import { afterEach, describe, expect, it, vi } from "vitest";
import { checkConnectivity } from "../connectivity.js";
import { log } from "../report/log.js";
import type { ProxyConfig } from "../types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    upstream: { url: "http://upstream.test", apiKey: "", agents: {} },
    clickhouse: { enabled: false },
    redis: { enabled: false },
    opik: { enabled: false, url: "", apiKey: "" },
    langfuse: { enabled: false, host: "" },
    auth: { enabled: false, url: "" },
    creditReport: { url: "" },
    ...overrides,
  } as ProxyConfig;
}

function responseWithText(text: () => Promise<string>): Response {
  return { text } as Response;
}

describe("startup HTTP connectivity probe", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("times out when response headers arrive but the body never finishes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      responseWithText(() => new Promise<string>(() => {})),
    ));
    const warn = vi.spyOn(log, "warn");

    let settled = false;
    const check = checkConnectivity(makeConfig()).then(() => {
      settled = true;
    });

    await vi.runAllTimersAsync();
    await check;

    expect(settled).toBe(true);
    expect(warn).toHaveBeenCalledWith("connectivity.check", expect.objectContaining({
      result: "some_failed",
      upstream: expect.stringMatching(/^FAIL:/),
    }));
  });

  it("reports FAIL when reading the response body rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      responseWithText(() => Promise.reject(new Error("body read failed"))),
    ));
    const info = vi.spyOn(log, "info");
    const warn = vi.spyOn(log, "warn");

    await checkConnectivity(makeConfig());

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("connectivity.check", expect.objectContaining({
      result: "some_failed",
      upstream: "FAIL: body read failed",
    }));
  });

  it("keeps a normally completed response successful", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      responseWithText(() => Promise.resolve("ok")),
    ));
    const info = vi.spyOn(log, "info");

    await checkConnectivity(makeConfig());

    expect(info).toHaveBeenCalledWith("connectivity.check", expect.objectContaining({
      result: "all_ok",
      upstream: expect.stringMatching(/^ok \(/),
    }));
  });

  it("clears the timeout when fetch fails before response headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const warn = vi.spyOn(log, "warn");

    await checkConnectivity(makeConfig());

    expect(warn).toHaveBeenCalledWith("connectivity.check", expect.objectContaining({
      upstream: "FAIL: connection refused",
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits a summary for all dependencies when one HTTP body hangs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      url.startsWith("http://upstream.test")
        ? responseWithText(() => Promise.resolve("ok"))
        : responseWithText(() => new Promise<string>(() => {})),
    )));
    const warn = vi.spyOn(log, "warn");
    const config = makeConfig({
      opik: {
        enabled: true,
        url: "http://opik.test",
        apiKey: "",
        stripRequestLogContent: false,
      },
    });

    let settled = false;
    const check = checkConnectivity(config).then(() => {
      settled = true;
    });

    await vi.runAllTimersAsync();
    await check;

    expect(settled).toBe(true);
    expect(warn).toHaveBeenCalledWith("connectivity.check", expect.objectContaining({
      result: "some_failed",
      upstream: expect.stringMatching(/^ok \(/),
      opik: expect.stringMatching(/^FAIL:/),
    }));
  });
});
