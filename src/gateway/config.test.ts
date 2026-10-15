import { describe, it, expect } from "vitest";
import { loadGatewayConfig } from "./config.js";
import { parseConfig } from "../config.js";

/**
 * Guard: structural multi-tenant isolation is physical (per-account dataDir +
 * its own SQLite). The TCVDB backend ignores dataDir and routes every core to
 * ONE shared database/collection set, so the combination would leak L1/L0
 * recall and search across accounts. `loadGatewayConfig` must refuse it at load
 * time. See the guard in config.ts and the review item (tcvdb isolation gap).
 *
 * A full `memory` override is passed so these assertions don't depend on the
 * repo-root tdai-gateway.yaml that loadGatewayConfig picks up from CWD.
 */
describe("loadGatewayConfig — multi-tenant store-backend guard", () => {
  const tcvdb = () =>
    parseConfig({ storeBackend: "tcvdb", tcvdb: { url: "https://x", apiKey: "k", database: "db" } });

  it("throws when multiTenant + storeBackend=tcvdb (would leak across accounts)", () => {
    expect(() =>
      loadGatewayConfig({
        data: { baseDir: "/tmp/tdai-test", multiTenant: true },
        memory: tcvdb(),
      }),
    ).toThrow(/multi-tenant/i);
  });

  it("allows multiTenant + sqlite (the supported structural-isolation backend)", () => {
    expect(() =>
      loadGatewayConfig({
        data: { baseDir: "/tmp/tdai-test", multiTenant: true },
        memory: parseConfig({}),
      }),
    ).not.toThrow();
  });

  it("allows single-tenant + tcvdb (one shared core, one database — no cross-account routing)", () => {
    expect(() =>
      loadGatewayConfig({
        data: { baseDir: "/tmp/tdai-test", multiTenant: false },
        memory: tcvdb(),
      }),
    ).not.toThrow();
  });
});
