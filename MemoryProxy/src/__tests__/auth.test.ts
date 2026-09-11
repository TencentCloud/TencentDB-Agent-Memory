import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../report/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initAuth, verifyUserKey } from "../auth.js";

const VALID = { code: 0, data: { valid: true, user: { user_id: "usr-1" } } };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("verifyUserKey against a gateway-protected MemoryCore (#1341)", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    initAuth({ enabled: false, url: "", timeoutMs: 0, apiKey: "" });
  });

  it("sends the configured bearer on the verify call", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, VALID));
    initAuth({ enabled: true, url: "http://kernel:8420/", timeoutMs: 0, apiKey: "gw-secret" });

    const result = await verifyUserKey("sk-mem-1", "default");

    expect(result).toEqual({ userId: "usr-1", rejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://kernel:8420/v3/meta/auth/verify");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-tdai-service-id": "default",
      "authorization": "Bearer gw-secret",
    });
    // The user key stays in the body, where the verify endpoint reads it.
    expect(JSON.parse(String(init?.body))).toEqual({ user_key: "sk-mem-1" });
  });

  it("sends no Authorization header when apiKey is empty (unchanged behaviour)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, VALID));
    initAuth({ enabled: true, url: "http://kernel:8420", timeoutMs: 0, apiKey: "" });

    await verifyUserKey("sk-mem-1", "default");

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-tdai-service-id": "default",
    });
  });

  it("still rejects when the gateway answers 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { code: 401 }));
    initAuth({ enabled: true, url: "http://kernel:8420", timeoutMs: 0, apiKey: "wrong" });

    const result = await verifyUserKey("sk-mem-1", "default");

    expect(result.rejected).toBe(true);
    expect(result.rejectReason).toBe("auth service returned HTTP 401");
  });
});
