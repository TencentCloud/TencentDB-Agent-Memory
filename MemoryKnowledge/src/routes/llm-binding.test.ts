import { describe, expect, it, vi } from "vitest";

import type {
  ILlmBindingStore,
  LlmBindingInput,
  LlmBindingRow,
} from "../store/llm-binding-store.js";
import { createLlmBindingRoutes } from "./llm-binding.js";

const SERVICE_ID = "service-1";

function binding(overrides: Partial<LlmBindingRow> = {}): LlmBindingRow {
  return {
    service_id: SERVICE_ID,
    mode: "proxy",
    proxy_base_url: "https://proxy.example.com",
    api_key: "existing-key",
    base_url: null,
    enabled: true,
    updated_at: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function createStore(initial: LlmBindingRow | null = null) {
  let current = initial;
  const upsert = vi.fn(
    (serviceId: string, input: LlmBindingInput): LlmBindingRow => {
      const previous = current;
      current = binding({
        service_id: serviceId,
        mode: input.mode,
        proxy_base_url: input.proxy_base_url ?? null,
        api_key:
          input.api_key === undefined
            ? (previous?.api_key ?? null)
            : input.api_key,
        base_url: input.base_url ?? null,
        enabled: input.enabled !== false,
      });
      return current;
    },
  );
  const store: ILlmBindingStore = {
    get: vi.fn(() => current),
    listAll: vi.fn(() => (current ? [current] : [])),
    upsert,
    status: vi.fn(() => ({
      bound: current !== null,
      mode: current?.mode ?? null,
      enabled: current?.enabled ?? false,
    })),
  };
  return { store, upsert };
}

async function setBinding(
  store: ILlmBindingStore,
  body: Record<string, unknown>,
): Promise<Response> {
  return await createLlmBindingRoutes({ llmBindingStore: store }).request("/set", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": SERVICE_ID,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /set", () => {
  it.each(["", "   ", "\t\n"])(
    "rejects an explicitly blank API key %#",
    async (apiKey) => {
      const { store, upsert } = createStore(binding());
      const response = await setBinding(store, {
        mode: "proxy",
        proxy_base_url: "https://proxy.example.com",
        api_key: apiKey,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 400,
        message: "api_key must be a non-blank string",
      });
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["proxy", "proxy_base_url", "   "],
    ["proxy", "proxy_base_url", "not a URL"],
    ["proxy", "proxy_base_url", "ftp://proxy.example.com"],
    ["byo", "base_url", "\n\t"],
    ["byo", "base_url", "/relative/v1"],
    ["byo", "base_url", "file:///tmp/llm.sock"],
  ] as const)(
    "rejects an invalid %s endpoint %#",
    async (mode, field, endpoint) => {
      const { store, upsert } = createStore();
      const response = await setBinding(store, {
        mode,
        [field]: endpoint,
        api_key: "secret",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 400,
        message: `${field} must be a valid HTTP(S) URL`,
      });
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it("normalizes the endpoint without modifying a non-blank API key", async () => {
    const { store, upsert } = createStore();
    const response = await setBinding(store, {
      mode: "proxy",
      proxy_base_url: "  https://proxy.example.com/v1/  ",
      api_key: "  exact secret  ",
    });

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      SERVICE_ID,
      expect.objectContaining({
        proxy_base_url: "https://proxy.example.com/v1/",
        api_key: "  exact secret  ",
      }),
    );
  });

  it("preserves the existing API key when the field is omitted", async () => {
    const { store, upsert } = createStore(binding());
    const response = await setBinding(store, {
      mode: "byo",
      base_url: "http://llm.example.com/v1",
    });

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      SERVICE_ID,
      expect.objectContaining({
        base_url: "http://llm.example.com/v1",
        api_key: undefined,
      }),
    );
  });
});
