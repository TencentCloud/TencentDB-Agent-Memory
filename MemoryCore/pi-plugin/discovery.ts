/**
 * Dynamic model discovery for the tdai provider.
 *
 * The proxy exposes `GET {baseUrl}/models` (handleModelsCatalog) — a
 * passthrough of the upstream gateway's OpenAI-style catalog
 * (`{ data: [...] }`). The mapping follows the same rules as
 * @lunaroute/pi-extension's discovery (same gateway shape, since the proxy
 * forwards gw.lunaroute.com/v1/models verbatim): reasoning models without a
 * client_compat.pi block are skipped, everything else maps 1:1. The static
 * TDAI_MODEL entry stays registered as the fallback so /model is non-empty
 * before the first refresh, offline, and against proxies not yet redeployed
 * with the /models route (they 404 the GET — the catch-all only covers POST).
 */
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const TDAI_PROVIDER = "tdai";
// Every model behind the proxy is served over OpenAI-completions; also set on
// the provider config, so toStoredModel mirrors provider-composer output and
// the catalog round-trips Pi's ModelsStore.
export const TDAI_API = "openai-completions" as const;

// ── Gateway catalog shape (client_compat.pi block) ──────────────────────────

export type GatewayPiBlock = {
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  compat?: Model<Api>["compat"];
} & Partial<Model<Api>["compat"]>;

export type GatewayModelObject = {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: Record<string, boolean>;
  client_compat?: { pi?: GatewayPiBlock } | null;
  pi?: GatewayPiBlock;
};

export type CatalogMappingResult =
  | { ok: true; model: ProviderModelConfig }
  | { ok: false; reason: "reasoning_missing_pi_block"; id: string };

function normalizeGatewayPiBlock(pi: GatewayPiBlock): {
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  compat?: Model<Api>["compat"];
} {
  const { thinkingLevelMap, compat: nestedCompat, ...flatCompat } = pi;
  return {
    thinkingLevelMap,
    compat: nestedCompat ?? (Object.keys(flatCompat).length > 0 ? flatCompat : undefined),
  };
}

export function mapCatalogEntry(entry: GatewayModelObject): CatalogMappingResult {
  const reasoning = entry.capabilities?.reasoning === true;
  const input: ("text" | "image")[] = entry.capabilities?.vision === true ? ["text", "image"] : ["text"];
  const gatewayPi = entry.client_compat?.pi ?? entry.pi;

  if (reasoning && !gatewayPi) {
    return { ok: false, reason: "reasoning_missing_pi_block", id: entry.id };
  }

  const model: ProviderModelConfig = {
    id: entry.id,
    name: entry.display_name ?? entry.id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_window ?? 0,
    maxTokens: entry.max_output_tokens ?? 0,
  };
  if (reasoning && gatewayPi) {
    const { thinkingLevelMap, compat } = normalizeGatewayPiBlock(gatewayPi);
    if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
    if (compat) model.compat = compat;
  }
  return { ok: true, model };
}

/** Persisted Model object for a mapped entry. Mirrors provider-composer's
 * applyExtension output (api/provider/baseUrl filled from the provider
 * config) so the entry survives a structuredClone through the ModelsStore
 * and re-applies cleanly on the next launch. */
export function toStoredModel(model: ProviderModelConfig, baseUrl: string): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api: model.api ?? TDAI_API,
    provider: TDAI_PROVIDER,
    baseUrl: model.baseUrl ?? baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  } as Model<Api>;
}

// ── refreshModels ───────────────────────────────────────────────────────────

export type RefreshModelsDeps = {
  /** Provider baseUrl (already includes /v1): fetch `${baseUrl}/models`. */
  baseUrl: string;
  /** TDAI user key — the proxy authenticates it before forwarding upstream. */
  userKey: string;
  /** Static TDAI_MODEL entry: last-resort fallback. */
  fallback: ProviderModelConfig;
  fetch?: typeof fetch;
};

/** Restored catalog from a prior session (stored entries are Model<Api>
 * objects — a structural superset of ProviderModelConfig). Falls back to the
 * static entry when nothing was persisted yet. */
function restore(
  stored: RefreshModelsContext["stored"],
  fallback: ProviderModelConfig,
): ProviderModelConfig[] {
  const models = stored?.models;
  return models && models.length > 0 ? ([...models] as ProviderModelConfig[]) : [fallback];
}

export function createRefreshModels(
  deps: RefreshModelsDeps,
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  const doFetch = deps.fetch ?? fetch;
  return async (context) => {
    // Phase 1 (offline / restore): surface the persisted catalog so getModels()
    // is non-empty at startup — before any network refresh. The static
    // fallback covers the very first launch (nothing persisted yet).
    if (!context.allowNetwork) return restore(context.stored, deps.fallback);

    try {
      const res = await doFetch(`${deps.baseUrl}/models`, {
        signal: context.signal,
        headers: { authorization: `Bearer ${deps.userKey}` },
      });
      // Old proxy without the /models route → 404 → keep what we have.
      if (!res.ok) return restore(context.stored, deps.fallback);

      const body = (await res.json()) as { data?: GatewayModelObject[] };
      const models: ProviderModelConfig[] = [];
      for (const entry of body.data ?? []) {
        const result = mapCatalogEntry(entry);
        if (result.ok) models.push(result.model);
      }
      if (!models.length) return restore(context.stored, deps.fallback);

      // Persist for next startup; the returned list replaces the in-memory
      // registry via the provider-composer wrapper. A store-write failure
      // must not discard the fresh catalog — the next refresh retries persist.
      await context
        .publish({
          persist: {
            models: models.map((m) => toStoredModel(m, deps.baseUrl)),
            checkedAt: Date.now(),
          },
        })
        .catch(() => {});
      return models;
    } catch {
      return restore(context.stored, deps.fallback);
    }
  };
}
