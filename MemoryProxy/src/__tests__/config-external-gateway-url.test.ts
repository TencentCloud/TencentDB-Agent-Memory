import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfig } from "../config.js";

describe("injection external gateway URL configuration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proxy-gateway-config-"));
    vi.stubEnv("INJECTION_EXTERNAL_GATEWAY_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function load(contents: string) {
    const configFile = join(dir, "config.yaml");
    writeFileSync(configFile, contents);
    return buildConfig({ configFile });
  }

  it("uses the environment value over YAML and preserves an explicit port", () => {
    vi.stubEnv("INJECTION_EXTERNAL_GATEWAY_URL", " http://127.0.0.1:8096/ ");
    const config = load("injection:\n  externalGatewayUrl: https://old.example.com\n");
    expect(config.injection.externalGatewayUrl).toBe("http://127.0.0.1:8096");
  });

  it("supports an environment-only value with a missing YAML file", () => {
    vi.stubEnv("INJECTION_EXTERNAL_GATEWAY_URL", "https://gateway.example.com/");
    expect(buildConfig({ configFile: join(dir, "missing.yaml") }).injection.externalGatewayUrl)
      .toBe("https://gateway.example.com");
  });

  it.each([undefined, "", "   "])("falls back to YAML when env is %s", (value) => {
    vi.stubEnv("INJECTION_EXTERNAL_GATEWAY_URL", value);
    expect(load("injection:\n  externalGatewayUrl: ' http://gateway.example.com:8096/ '\n")
      .injection.externalGatewayUrl).toBe("http://gateway.example.com:8096");
  });

  it.each(["injection: {}\n", "injection:\n  externalGatewayUrl: '  '\n", "injection:\n  externalGatewayUrl: 123\n"])(
    "leaves URL unset for absent or invalid YAML: %s", (yaml) => {
      expect(load(yaml).injection.externalGatewayUrl).toBeUndefined();
    },
  );

  it("does not enable injectors or change listener settings", () => {
    vi.stubEnv("INJECTION_EXTERNAL_GATEWAY_URL", "https://gateway.example.com:9443/");
    const config = load("server:\n  host: 127.0.0.1\n  port: 9000\ninjection:\n  enabled: false\n  injectors: []\n");
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(9000);
    expect(config.injection.enabled).toBe(false);
    expect(config.injection.injectors).toEqual([]);
  });
});
