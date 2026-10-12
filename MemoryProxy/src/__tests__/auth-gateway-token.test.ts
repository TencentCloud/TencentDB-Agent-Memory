import { afterEach, describe, expect, it, vi } from "vitest";

import { initAuth, verifyUserKey } from "../auth.js";

const validResponse = () =>
  new Response(
    JSON.stringify({
      code: 0,
      data: { valid: true, user: { user_id: "usr-test" } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  initAuth({ enabled: false, url: "", serviceToken: "", timeoutMs: 0 });
});

describe("auth gateway service token", () => {
  it("sends the internal token as Bearer without replacing the user_key body", async () => {
    const fetchMock = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(
      async () => validResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    initAuth({
      enabled: true,
      url: "http://memory-core:8420",
      serviceToken: "gateway-secret",
      timeoutMs: 0,
    });

    await expect(verifyUserKey("user-secret", "default")).resolves.toEqual({
      userId: "usr-test",
      rejected: false,
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://memory-core:8420/v3/meta/auth/verify");
    expect(options.headers).toMatchObject({
      "content-type": "application/json",
      "x-tdai-service-id": "default",
      authorization: "Bearer gateway-secret",
    });
    expect(JSON.parse(String(options.body))).toEqual({ user_key: "user-secret" });
  });

  it("preserves legacy requests when no internal token is configured", async () => {
    const fetchMock = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(
      async () => validResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    initAuth({
      enabled: true,
      url: "http://memory-core:8420",
      serviceToken: "",
      timeoutMs: 0,
    });

    await verifyUserKey("user-secret", "default");

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).not.toHaveProperty("authorization");
  });
});
