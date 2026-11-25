import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initAuth, verifyUserKey } from "../auth.js";
import { buildConfig } from "../config.js";
import type { AuthConfig } from "../types.js";

function validVerifyResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: { valid: true, user: { user_id: "usr-test" } },
    }),
  } as Response;
}

describe("MemoryProxy auth service client", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the configured gateway Bearer token to the auth verify endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(validVerifyResponse());
    vi.stubGlobal("fetch", fetchMock);
    initAuth({
      enabled: true,
      url: "http://memory-core.test:8420",
      timeoutMs: 0,
      apiKey: "gateway-secret",
    });

    const result = await verifyUserKey("sk-mem-user", "default");

    expect(result).toEqual({ userId: "usr-test", rejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://memory-core.test:8420/v3/meta/auth/verify");
    expect(request.headers).toEqual(expect.objectContaining({
      authorization: "Bearer gateway-secret",
    }));
    expect(JSON.parse(String(request.body))).toEqual({ user_key: "sk-mem-user" });
  });

  it("keeps the verify request unchanged when no gateway token is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(validVerifyResponse());
    vi.stubGlobal("fetch", fetchMock);
    initAuth({
      enabled: true,
      url: "http://memory-core.test:8420",
      timeoutMs: 0,
    });

    await verifyUserKey("sk-mem-user", "default");

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.headers).not.toHaveProperty("authorization");
  });

  it("remains compatible with an AuthConfig object that has the optional token", () => {
    const config: AuthConfig = {
      enabled: true,
      url: "http://memory-core.test:8420",
      timeoutMs: 5000,
      apiKey: "gateway-secret",
    };

    expect(config.apiKey).toBe("gateway-secret");
  });

  it("loads the optional gateway token from configuration", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "proxy-auth-config-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "config.yaml");
    writeFileSync(configPath, [
      "auth:",
      "  enabled: true",
      "  url: http://memory-core.test:8420",
      "  apiKey: yaml-secret",
      "",
    ].join("\n"), "utf8");

    const config = buildConfig({ configFile: configPath });

    expect(config.auth.apiKey).toBe("yaml-secret");
  });
});
