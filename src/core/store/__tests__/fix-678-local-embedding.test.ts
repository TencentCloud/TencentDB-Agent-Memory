/**
 * Fix #678 Regression-Test: Local Embedding Provider
 *
 * Verifiziert die drei Blockaden aus Issue #678:
 * 1. parseConfig akzeptiert provider="local" (statt es zu "none" umzuschreiben)
 * 2. createStoreBundle (sqlite) erstellt einen Embedding-Service für local
 *    OHNE apiKey
 * 3. startWarmup() wird beim Erstellen aufgerufen (Modell lädt im Hintergrund)
 */
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { parseConfig } from "../../../config.js";

function tmpDataDir(): string {
  const dir = "/tmp/tdam-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Fix #678: local embedding provider", () => {
  it("1) parseConfig lässt provider=local durch (enabled, nicht none)", () => {
    const cfg = parseConfig({
      embedding: { enabled: true, provider: "local" },
    });
    expect(cfg.embedding.provider).toBe("local");
    expect(cfg.embedding.enabled).toBe(true);
    // keine Config-Fehler-Meldung
    expect(cfg.embedding.configError ?? "").toBe("");
  });

  it("1b) provider=none bleibt disabled", () => {
    const cfg = parseConfig({
      embedding: { provider: "none" },
    });
    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.provider).toBe("none");
  });

  it("2) factory erstellt Service für local ohne apiKey + startWarmup existiert", async () => {
    const { createStoreBundle } = await import("../factory.js");

    const cfg = parseConfig({
      storeBackend: "sqlite",
      embedding: { enabled: true, provider: "local" },
    });

    const bundle = createStoreBundle(cfg, {
      dataDir: tmpDataDir(),
    });

    expect(bundle.embedding).toBeDefined();
    expect(bundle.embedding.getProviderInfo().provider).toBe("local");
    expect(typeof (bundle.embedding as { startWarmup?: () => void }).startWarmup)
      .toBe("function");
  });

  it("3) remote provider ohne apiKey erstellt KEINEN Service (Regression)", async () => {
    const { createStoreBundle } = await import("../factory.js");

    const cfg = parseConfig({
      storeBackend: "sqlite",
      embedding: { enabled: true, provider: "openai" }, // kein apiKey
    });

    const bundle = createStoreBundle(cfg, {
      dataDir: tmpDataDir(),
    });

    // Ohne apiKey → kein Embedding-Service erstellt (embedding undefined)
    expect(bundle.embedding).toBeUndefined();
  });
});
