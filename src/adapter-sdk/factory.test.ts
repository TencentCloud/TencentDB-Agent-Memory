/**
 * createMemoryClient / resolveClientOptionsFromEnv unit tests (offline).
 */

import { describe, expect, it, vi } from "vitest";

import { createMemoryClient, resolveClientOptionsFromEnv } from "./factory.js";
import { HttpMemoryClient } from "./transports/http.js";
import { InProcessMemoryClient } from "./transports/in-process.js";
import type { MemoryClientOptions } from "./factory.js";

describe("createMemoryClient", () => {
  it("returns an HttpMemoryClient for transport 'http'", () => {
    const client = createMemoryClient({ transport: "http", baseUrl: "http://127.0.0.1:9999" });
    expect(client).toBeInstanceOf(HttpMemoryClient);
  });

  it("returns an InProcessMemoryClient for transport 'in-process'", () => {
    const client = createMemoryClient({ transport: "in-process" });
    expect(client).toBeInstanceOf(InProcessMemoryClient);
  });

  it("throws on an unknown transport (runtime misuse)", () => {
    expect(() =>
      createMemoryClient({ transport: "carrier-pigeon" } as unknown as MemoryClientOptions),
    ).toThrow(/Unknown MemoryClient transport/);
  });
});

describe("resolveClientOptionsFromEnv", () => {
  it("defaults to http transport with no env set", () => {
    vi.stubEnv("TDAI_ADAPTER_TRANSPORT", "");
    vi.stubEnv("TDAI_GATEWAY_URL", "");
    vi.stubEnv("TDAI_GATEWAY_API_KEY", "");
    vi.stubEnv("TDAI_ADAPTER_TIMEOUT_MS", "");

    const opts = resolveClientOptionsFromEnv();

    expect(opts.transport).toBe("http");
    if (opts.transport === "http") {
      expect(opts.baseUrl).toBeUndefined();
      expect(opts.apiKey).toBeUndefined();
      expect(opts.timeoutMs).toBeUndefined();
    }
  });

  it("reads http options from TDAI_GATEWAY_URL / TDAI_GATEWAY_API_KEY / TDAI_ADAPTER_TIMEOUT_MS", () => {
    vi.stubEnv("TDAI_ADAPTER_TRANSPORT", "http");
    vi.stubEnv("TDAI_GATEWAY_URL", "http://10.0.0.5:8420");
    vi.stubEnv("TDAI_GATEWAY_API_KEY", "sk-test");
    vi.stubEnv("TDAI_ADAPTER_TIMEOUT_MS", "2500");

    const opts = resolveClientOptionsFromEnv();

    expect(opts).toMatchObject({
      transport: "http",
      baseUrl: "http://10.0.0.5:8420",
      apiKey: "sk-test",
      timeoutMs: 2500,
    });
  });

  it("selects in-process transport via TDAI_ADAPTER_TRANSPORT", () => {
    vi.stubEnv("TDAI_ADAPTER_TRANSPORT", "in-process");

    const opts = resolveClientOptionsFromEnv();

    expect(opts.transport).toBe("in-process");
  });

  it("falls back to http (with a warning) on an unknown transport value", () => {
    vi.stubEnv("TDAI_ADAPTER_TRANSPORT", "grpc");
    const warn = vi.fn();

    const opts = resolveClientOptionsFromEnv({ info: vi.fn(), warn, error: vi.fn() });

    expect(opts.transport).toBe("http");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("grpc"));
  });

  it("ignores a non-numeric timeout", () => {
    vi.stubEnv("TDAI_ADAPTER_TRANSPORT", "http");
    vi.stubEnv("TDAI_ADAPTER_TIMEOUT_MS", "soon");

    const opts = resolveClientOptionsFromEnv();

    expect(opts.transport).toBe("http");
    if (opts.transport === "http") expect(opts.timeoutMs).toBeUndefined();
  });
});
