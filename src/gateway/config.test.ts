import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGatewayConfigWarningsForTest, loadGatewayConfig } from "./config.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "tdai-gateway-config-"));
}

describe("gateway config path resolution", () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = makeTempDir();
    process.chdir(tempDir);
    _resetGatewayConfigWarningsForTest();
    vi.stubEnv("HOME", path.join(tempDir, "home"));
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("MEMORY_TENCENTDB_ROOT", "");
    vi.stubEnv("TDAI_DATA_DIR", "");
    vi.stubEnv("TDAI_GATEWAY_CONFIG", "");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _resetGatewayConfigWarningsForTest();
  });

  it("loads Linux config from XDG_CONFIG_HOME/tencentdb-agent-memory", () => {
    const xdgConfigHome = path.join(tempDir, "xdg-config");
    const configDir = path.join(xdgConfigHome, "tencentdb-agent-memory");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "tdai-gateway.yaml"),
      [
        "server:",
        "  port: 9511",
        "  host: 0.0.0.0",
        "data:",
        "  baseDir: /tmp/tdai-xdg-data",
        "",
      ].join("\n"),
    );

    vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);

    const config = loadGatewayConfig();

    expect(config.server.port).toBe(9511);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.data.baseDir).toBe("/tmp/tdai-xdg-data");
  });

  it("warns only once when TDAI_GATEWAY_CONFIG points to a missing file", () => {
    const missingPath = path.join(tempDir, "missing", "tdai-gateway.yaml");
    vi.stubEnv("TDAI_GATEWAY_CONFIG", missingPath);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    loadGatewayConfig();
    loadGatewayConfig();

    const messages = stderrWrite.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("TDAI_GATEWAY_CONFIG points to missing config");
    expect(messages[0]).toContain(missingPath);
  });

  it("warns only once when falling back to the legacy data directory", () => {
    const home = path.join(tempDir, "legacy-home");
    const legacyDataDir = path.join(home, "memory-tdai");
    fs.mkdirSync(legacyDataDir, { recursive: true });
    vi.stubEnv("HOME", home);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const first = loadGatewayConfig();
    const second = loadGatewayConfig();

    expect(first.data.baseDir).toBe(legacyDataDir);
    expect(second.data.baseDir).toBe(legacyDataDir);
    const messages = stderrWrite.mock.calls.map((call) => String(call[0]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("DEPRECATED: using legacy data dir");
  });
});
