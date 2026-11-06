/**
 * Tests for discovery.ts — catalog mapping, stored-model shape, and the
 * refreshModels fallback chain (offline → stored → static; 404/network
 * failure → stored/static; success → mapped catalog + persist).
 */
import { describe, it, expect } from "vitest";
import {
  mapCatalogEntry,
  toStoredModel,
  createRefreshModels,
  type GatewayModelObject,
} from "../discovery.js";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

const fallback: ProviderModelConfig = {
  id: "glm-5.2-vision",
  name: "glm-5.2-vision",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 524288,
  maxTokens: 16384,
};

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as RefreshModelsContext;
}

describe("mapCatalogEntry", () => {
  it("maps a non-reasoning model without a pi block", () => {
    const entry: GatewayModelObject = { id: "flux2-klein" };
    const result = mapCatalogEntry(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("flux2-klein");
      expect(result.model.reasoning).toBe(false);
      expect(result.model.input).toEqual(["text"]);
    }
  });

  it("rejects a reasoning model without a pi block", () => {
    const entry: GatewayModelObject = {
      id: "some-reasoner",
      capabilities: { reasoning: true },
    };
    const result = mapCatalogEntry(entry);
    expect(result).toEqual({ ok: false, reason: "reasoning_missing_pi_block", id: "some-reasoner" });
  });

  it("maps a reasoning model with client_compat.pi (thinkingLevelMap + vision)", () => {
    const entry: GatewayModelObject = {
      id: "glm-5.2-vision",
      display_name: "GLM 5.2 Vision",
      context_window: 524288,
      max_output_tokens: 16384,
      capabilities: { reasoning: true, vision: true },
      client_compat: {
        pi: { thinkingLevelMap: { off: "none", high: "high" } },
      },
    };
    const result = mapCatalogEntry(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.reasoning).toBe(true);
      expect(result.model.input).toEqual(["text", "image"]);
      expect(result.model.thinkingLevelMap).toEqual({ off: "none", high: "high" });
      expect(result.model.contextWindow).toBe(524288);
    }
  });

  it("maps a reasoning model with a top-level pi block", () => {
    const entry: GatewayModelObject = {
      id: "glm-5.3-flash",
      capabilities: { reasoning: true },
      pi: { thinkingLevelMap: { off: "none", max: "max" } },
    };
    const result = mapCatalogEntry(entry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.thinkingLevelMap).toEqual({ off: "none", max: "max" });
    }
  });
});

describe("toStoredModel", () => {
  it("fills api/provider/baseUrl so the entry round-trips the ModelsStore", () => {
    const stored = toStoredModel(fallback, "http://127.0.0.1:8096/pi/default/v1");
    expect(stored.api).toBe("openai-completions");
    expect(stored.provider).toBe("tdai");
    expect(stored.baseUrl).toBe("http://127.0.0.1:8096/pi/default/v1");
    expect(stored.id).toBe("glm-5.2-vision");
  });
});

describe("createRefreshModels", () => {
  const deps = {
    baseUrl: "http://127.0.0.1:8096/pi/default/v1",
    userKey: "sk-mem-test",
    fallback,
  };

  it("offline (allowNetwork=false) restores the stored catalog", async () => {
    const refresh = createRefreshModels(deps);
    const ctx = makeContext({
      allowNetwork: false,
      stored: { models: [toStoredModel(fallback, deps.baseUrl)], checkedAt: 1 },
    });
    const models = await refresh(ctx);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("glm-5.2-vision");
  });

  it("offline with nothing stored falls back to the static entry", async () => {
    const refresh = createRefreshModels(deps);
    const models = await refresh(makeContext({ allowNetwork: false }));
    expect(models).toEqual([fallback]);
  });

  it("fetches the catalog, maps entries, and persists", async () => {
    const fetchCalls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push(`${url} ${init?.headers ? (init.headers as Record<string, string>).authorization : ""}`);
      return new Response(
        JSON.stringify({
          data: [
            { id: "glm-5.2-vision", capabilities: { reasoning: true, vision: true }, client_compat: { pi: { thinkingLevelMap: { high: "high" } } } },
            { id: "flux2-klein" },
            { id: "broken-reasoner", capabilities: { reasoning: true } }, // skipped
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const published: unknown[] = [];
    const refresh = createRefreshModels({ ...deps, fetch: fakeFetch });
    const models = await refresh(
      makeContext({
        publish: async (pub) => {
          published.push(pub);
          return true;
        },
      }),
    );

    expect(models.map((m) => m.id)).toEqual(["glm-5.2-vision", "flux2-klein"]);
    expect(published).toHaveLength(1);
    expect(fetchCalls).toEqual([`${deps.baseUrl}/models Bearer sk-mem-test`]);
  });

  it("404 from an old proxy falls back to stored, then static", async () => {
    const fakeFetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const refresh = createRefreshModels({ ...deps, fetch: fakeFetch });

    // Nothing stored → static fallback.
    expect(await refresh(makeContext())).toEqual([fallback]);

    // Something stored → stored wins over static.
    const ctx = makeContext({
      stored: { models: [toStoredModel({ ...fallback, id: "glm-5.3" }, deps.baseUrl)], checkedAt: 1 },
    });
    const models = await refresh(ctx);
    expect(models[0].id).toBe("glm-5.3");
  });

  it("network failure falls back without throwing", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const refresh = createRefreshModels({ ...deps, fetch: fakeFetch });
    const models = await refresh(makeContext());
    expect(models).toEqual([fallback]);
  });

  it("empty catalog mapping falls back (no empty-list replacement)", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "broken-reasoner", capabilities: { reasoning: true } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const refresh = createRefreshModels({ ...deps, fetch: fakeFetch });
    const models = await refresh(makeContext());
    expect(models).toEqual([fallback]);
  });
});
