import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../report/log.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { DEFAULT_CONFIG } from "../config.js";
import { checkConnectivity } from "../connectivity.js";

describe("connectivity HTTP probe cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("clears the abort deadline when fetch fails before the timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    await checkConnectivity({
      ...DEFAULT_CONFIG,
      upstream: {
        ...DEFAULT_CONFIG.upstream,
        url: "http://upstream.invalid/health",
      },
      creditReport: {
        ...DEFAULT_CONFIG.creditReport,
        url: "",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
