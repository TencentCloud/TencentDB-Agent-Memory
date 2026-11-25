import { afterEach, expect, it, vi } from "vitest";
import { MemoryGenerationLogClient } from "../src/v3/memory-generation-log-client.js";
import type { MemoryGenerationLogGetRequest } from "../src/v3/memory-generation-log-types.js";
import { ParamError } from "../src/errors.js";

afterEach(() => vi.unstubAllGlobals());

it("omits an undefined log_id when selecting a memory generation log", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: { log_id: "found" } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new MemoryGenerationLogClient({ endpoint: "https://fixture.invalid", apiKey: "fixture", serviceId: "fixture" });
  const request: MemoryGenerationLogGetRequest = { memory_id: "memory-1", layer: "l1", log_id: undefined };

  expect(await client.get(request)).toEqual({ log_id: "found" });
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.pathname).toBe("/v3/memory-generation-log/get");
  expect(Object.fromEntries(url.searchParams)).toEqual({ memory_id: "memory-1", layer: "l1" });
});

it("preserves explicit log-id lookups and rejects empty IDs", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new MemoryGenerationLogClient({ endpoint: "https://fixture.invalid", apiKey: "fixture", serviceId: "fixture" });

  await client.get({ log_id: "log-1" });
  expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("log_id")).toBe("log-1");
  expect(() => client.get({ log_id: "" })).toThrow(ParamError);
  expect(() => client.get({ memory_id: "", layer: "l1" })).toThrow(ParamError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
