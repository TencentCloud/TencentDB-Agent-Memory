import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGatewayConfig } from "./config.js";

/**
 * Config-file resolution, focused on the `TDAI_DATA_DIR` search step:
 * a config file stored next to the relocated data dir must be picked up
 * (previously only CWD and the *default* data dir were searched, so the
 * gateway silently ran on defaults whenever `TDAI_DATA_DIR` was set).
 */
describe("loadGatewayConfig config-file resolution", () => {
  let dataDir: string;
  let emptyCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-data-"));
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-cwd-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(emptyCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  });

  it("finds tdai-gateway.json inside TDAI_DATA_DIR", () => {
    fs.writeFileSync(
      path.join(dataDir, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 9999 } }),
    );
    vi.stubEnv("TDAI_DATA_DIR", dataDir);

    const config = loadGatewayConfig();

    expect(config.server.port).toBe(9999);
    expect(config.data.baseDir).toBe(dataDir);
  });

  it("ignores the data-dir config when TDAI_DATA_DIR is not set", () => {
    fs.writeFileSync(
      path.join(dataDir, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 9999 } }),
    );

    const config = loadGatewayConfig();

    expect(config.server.port).toBe(8420);
  });

  it("prefers a CWD config over the TDAI_DATA_DIR config", () => {
    fs.writeFileSync(
      path.join(emptyCwd, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 7777 } }),
    );
    fs.writeFileSync(
      path.join(dataDir, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 9999 } }),
    );
    vi.stubEnv("TDAI_DATA_DIR", dataDir);

    const config = loadGatewayConfig();

    expect(config.server.port).toBe(7777);
  });

  it("prefers an explicit TDAI_GATEWAY_CONFIG over the TDAI_DATA_DIR config", () => {
    const explicit = path.join(dataDir, "explicit.json");
    fs.writeFileSync(explicit, JSON.stringify({ server: { port: 6666 } }));
    fs.writeFileSync(
      path.join(dataDir, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 9999 } }),
    );
    vi.stubEnv("TDAI_GATEWAY_CONFIG", explicit);
    vi.stubEnv("TDAI_DATA_DIR", dataDir);

    const config = loadGatewayConfig();

    expect(config.server.port).toBe(6666);
  });
});
