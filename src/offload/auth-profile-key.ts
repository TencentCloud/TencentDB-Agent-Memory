/**
 * Auth-profile API key resolver for offload local mode.
 *
 * OpenClaw stores model credentials in two places:
 *   1. `models.providers[provider].apiKey` — plaintext in openclaw.json
 *   2. auth-profiles store — the credential "vault" populated by `openclaw auth`
 *
 * The offload local-llm path historically only read location (1). When users
 * manage their keys via auth-profiles (location 2) — the OpenClaw-recommended
 * default — the lookup misses and L1/L1.5/L2 get disabled (see issue #90).
 *
 * This module provides a SYNCHRONOUS fallback that reads the key from the
 * auth-profile store, so `registerOffload` keeps its synchronous contract and
 * no race is introduced around `backendClient`.
 *
 * Compatibility: the `openclaw/plugin-sdk/provider-auth` subpath only exists on
 * newer OpenClaw versions. All host calls are guarded so that on older hosts
 * (or any unexpected failure) we silently fall back to the previous behavior
 * of "config-tree only".
 */
import { createRequire } from "node:module";

import type { PluginLogger } from "./types.js";

const TAG = "[context-offload] [auth-profile]";

// The plugin is ESM ("type": "module"), so `require` is not a global. Create a
// CJS require bound to this module's URL — matches the pattern in the plugin
// entry (index.ts) and lets us tolerate a missing SDK subpath on older hosts.
const _require = createRequire(import.meta.url);

/**
 * Resolve an API key for `providerKey` from OpenClaw's auth-profile store.
 *
 * Returns the plaintext key for the first `api_key`-type profile bound to the
 * provider, or `undefined` when nothing usable is found (no profile, only
 * oauth/token credentials, indirect keyRef-only storage, or an older host that
 * does not expose the auth-profile SDK).
 *
 * This is intentionally synchronous: the underlying store loaders
 * (`ensureAuthProfileStore`, `listProfilesForProvider`) are synchronous, which
 * lets the caller resolve the key inline without awaiting.
 *
 * @param api - OpenClaw plugin api (its `config` is forwarded to the resolver).
 * @param providerKey - Provider name parsed from the model ref (e.g. "xiaomi").
 * @param logger - Optional logger; failures are reported at debug level.
 */
export function resolveApiKeyFromAuthProfile(
  api: { config?: unknown },
  providerKey: string,
  logger?: PluginLogger,
  _loadSdkOverride?: () => ProviderAuthSdk | undefined,
): string | undefined {
  try {
    // Lazily load the SDK subpath so a missing export on older OpenClaw
    // versions degrades gracefully instead of crashing module load.
    const sdk = _loadSdkOverride ? _loadSdkOverride() : loadProviderAuthSdk();
    if (!sdk) return undefined;

    const { ensureAuthProfileStore, listProfilesForProvider, resolveOpenClawAgentDir } = sdk;
    if (
      typeof ensureAuthProfileStore !== "function" ||
      typeof listProfilesForProvider !== "function"
    ) {
      return undefined;
    }

    const agentDir =
      typeof resolveOpenClawAgentDir === "function" ? resolveOpenClawAgentDir() : undefined;

    const store = ensureAuthProfileStore(agentDir, { config: api.config });
    if (!store || typeof store !== "object") return undefined;

    const profileIds = listProfilesForProvider(store, providerKey);
    if (!Array.isArray(profileIds) || profileIds.length === 0) return undefined;

    const profiles = (store as { profiles?: Record<string, unknown> }).profiles ?? {};
    for (const id of profileIds) {
      const cred = profiles[id] as { type?: string; key?: string } | undefined;
      // Only api_key credentials carry a directly-usable plaintext key.
      // oauth/token profiles, or api_key profiles that store only a keyRef
      // (indirect/keychain), cannot be consumed by the OpenAI-compatible
      // local-llm caller, so we skip them.
      if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key.length > 0) {
        logger?.debug?.(`${TAG} Resolved api key for provider "${providerKey}" from profile "${id}"`);
        return cred.key;
      }
    }
    return undefined;
  } catch (err) {
    logger?.debug?.(
      `${TAG} Auth-profile lookup unavailable for provider "${providerKey}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

interface ProviderAuthSdk {
  ensureAuthProfileStore?: (
    agentDir?: string,
    options?: { config?: unknown },
  ) => { profiles?: Record<string, unknown> } | null | undefined;
  listProfilesForProvider?: (store: unknown, provider: string) => string[];
  resolveOpenClawAgentDir?: () => string;
}

/**
 * Load the `openclaw/plugin-sdk/provider-auth` subpath.
 *
 * Uses the module-scoped CJS require so a missing subpath (older hosts)
 * surfaces as a caught error rather than an unhandled module-resolution
 * failure.
 */
function loadProviderAuthSdk(): ProviderAuthSdk | undefined {
  try {
    return _require("openclaw/plugin-sdk/provider-auth") as ProviderAuthSdk;
  } catch {
    return undefined;
  }
}
