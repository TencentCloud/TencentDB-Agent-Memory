import { describe, it, expect } from "vitest";
import { resolveApiKeyFromAuthProfile } from "./auth-profile-key.js";

/**
 * Build a fake provider-auth SDK whose store contains the given profiles and
 * whose `listProfilesForProvider` maps a provider name to its profile ids.
 */
function makeSdk(
  profiles: Record<string, { type?: string; key?: string; keyRef?: unknown }>,
  profileIdsByProvider: Record<string, string[]>,
) {
  return {
    ensureAuthProfileStore: () => ({ profiles }),
    listProfilesForProvider: (_store: unknown, provider: string) =>
      profileIdsByProvider[provider] ?? [],
    resolveOpenClawAgentDir: () => "/fake/agent/dir",
  };
}

const api = { config: { models: { providers: {} } } };

describe("resolveApiKeyFromAuthProfile", () => {
  it("returns the plaintext key for an api_key profile bound to the provider", () => {
    const sdk = makeSdk(
      { "xiaomi:default": { type: "api_key", key: "sk-xiaomi-123" } },
      { xiaomi: ["xiaomi:default"] },
    );

    const key = resolveApiKeyFromAuthProfile(api, "xiaomi", undefined, () => sdk);

    expect(key).toBe("sk-xiaomi-123");
  });

  it("returns undefined when the provider only has oauth/token profiles", () => {
    const sdk = makeSdk(
      {
        "claude:default": { type: "oauth" },
        "github:default": { type: "token" },
      },
      { anthropic: ["claude:default"], github: ["github:default"] },
    );

    expect(resolveApiKeyFromAuthProfile(api, "anthropic", undefined, () => sdk)).toBeUndefined();
    expect(resolveApiKeyFromAuthProfile(api, "github", undefined, () => sdk)).toBeUndefined();
  });

  it("returns undefined when the provider has no profiles at all", () => {
    const sdk = makeSdk(
      { "xiaomi:default": { type: "api_key", key: "sk-xiaomi-123" } },
      { xiaomi: ["xiaomi:default"] },
    );

    expect(resolveApiKeyFromAuthProfile(api, "deepseek", undefined, () => sdk)).toBeUndefined();
  });

  it("skips api_key profiles that store only a keyRef (no plaintext key)", () => {
    const sdk = makeSdk(
      { "vault:default": { type: "api_key", keyRef: { source: "keychain" } } },
      { vault: ["vault:default"] },
    );

    expect(resolveApiKeyFromAuthProfile(api, "vault", undefined, () => sdk)).toBeUndefined();
  });

  it("returns undefined when the provider-auth SDK is unavailable (older host)", () => {
    expect(resolveApiKeyFromAuthProfile(api, "xiaomi", undefined, () => undefined)).toBeUndefined();
  });
});
