import { afterEach, describe, expect, it, vi } from "vitest";

import { TDAMError } from "../src/errors.js";
import { HttpTransport } from "../src/http.js";
import { V3HttpTransport } from "../src/v3/http.js";

/**
 * Envelope `data` handling shared by both TS transports.
 *
 * A successful (`code === 0`) response must only fall back to an empty
 * object when `data` is null/undefined; every other non-object payload —
 * including falsy ones (`[]`/`""`/`0`/`false`) — is malformed and must
 * raise `TDAMError` instead of passing through as bogus data (or crashing
 * the trace-id write on a primitive). Mirrors the None-only rule enforced
 * by the Python transports.
 */

function mockFetch(payload: unknown, headers: Record<string, string> = {}) {
  const response = new Response(JSON.stringify(payload), { status: 200, headers });
  vi.stubGlobal("fetch", async () => response);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("v2 HttpTransport envelope data", () => {
  const transport = new HttpTransport({
    endpoint: "https://memory.example.com",
    apiKey: "k",
    serviceId: "svc",
  });

  it("falls back to {} and propagates trace_id for null data", async () => {
    mockFetch({ code: 0, message: "ok", data: null }, { "x-trace-id": "t-1" });
    const result = await transport.post("/v2/echo", {});
    expect(result).toEqual({ trace_id: "t-1" });
  });

  it("passes object data through with trace_id", async () => {
    mockFetch({ code: 0, data: { items: [1], total: 1 } }, { "x-trace-id": "t-2" });
    const result = await transport.post<{ items: number[]; total: number }>("/v2/echo", {});
    expect(result).toEqual({ items: [1], total: 1, trace_id: "t-2" });
  });

  it.each([false, [], "x", 0])("rejects non-object data %j with TDAMError", async (data) => {
    mockFetch(
      { code: 0, message: "ok", data },
      { "x-trace-id": "t-3", "x-qcloud-transaction-id": "req-9" },
    );
    await expect(transport.post("/v2/echo", {})).rejects.toMatchObject({
      name: "TDAMError",
      code: -1,
      requestId: "req-9",
    });
  });
});

describe("v3 V3HttpTransport envelope data", () => {
  const transport = new V3HttpTransport({
    endpoint: "https://memory.example.com",
    apiKey: "k",
    serviceId: "svc",
  });

  it("falls back to {} for null data", async () => {
    mockFetch({ code: 0, message: "ok", data: null }, { "x-trace-id": "t-4" });
    const result = await transport.post("/v3/echo", {});
    expect(result).toEqual({ trace_id: "t-4" });
  });

  it("passes object data through with trace_id", async () => {
    mockFetch({ code: 0, data: { ok: true } }, { "x-trace-id": "t-5" });
    const result = await transport.post<{ ok: boolean }>("/v3/echo", {});
    expect(result).toEqual({ ok: true, trace_id: "t-5" });
  });

  it.each([false, [], "x", 0])("rejects non-object data %j with TDAMError", async (data) => {
    mockFetch(
      { code: 0, message: "ok", data },
      { "x-qcloud-transaction-id": "req-7" },
    );
    const error = await transport.post("/v3/echo", {}).catch((e) => e);
    expect(error).toBeInstanceOf(TDAMError);
    expect(error).toMatchObject({ code: -1, requestId: "req-7" });
  });
});
