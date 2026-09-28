import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "../gateway/config.js";
import { resolveOpenClawConfigPath } from "./ensure-hook-policy.js";
import { resolveOpenClawStateDir } from "./openclaw-state-dir.js";

const ORIGINAL_CWD = process.cwd();

let tempDir = "";

function clearGatewayEnv(): void {
  for (const key of [
    "TDAI_GATEWAY_CONFIG",
    "TDAI_GATEWAY_PORT",
    "TDAI_GATEWAY_HOST",
    "TDAI_DATA_DIR",
    "MEMORY_TENCENTDB_ROOT",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
    "XDG_CONFIG_HOME",
  ]) {
    vi.stubEnv(key, "");
  }
}

describe("config path resolution", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-config-paths-"));
    process.chdir(tempDir);
    clearGatewayEnv();
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("loads gateway config from XDG_CONFIG_HOME independent of host platform", () => {
    const home = path.join(tempDir, "home");
    const xdg = path.join(tempDir, "xdg");
    const appDir = path.join(xdg, "tencentdb-agent-memory");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "tdai-gateway.yaml"),
      "server:\n  port: 9511\n  host: 127.0.0.2\n",
      "utf-8",
    );

    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("XDG_CONFIG_HOME", xdg);

    const cfg = loadGatewayConfig();

    expect(cfg.server.port).toBe(9511);
    expect(cfg.server.host).toBe("127.0.0.2");
  });

  it("loads gateway config from HOME/.config when XDG_CONFIG_HOME is unset", () => {
    const home = path.join(tempDir, "home");
    const appDir = path.join(home, ".config", "tencentdb-agent-memory");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "tdai-gateway.json"),
      JSON.stringify({
        server: { port: 9461 },
        data: { baseDir: "~/memory-data" },
      }),
      "utf-8",
    );

    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", "");

    const cfg = loadGatewayConfig();

    expect(cfg.server.port).toBe(9461);
    expect(cfg.data.baseDir).toBe(path.join(home, "memory-data"));
  });

  it("resolves OpenClaw config from USERPROFILE fallback without HOME", () => {
    const profile = path.join(tempDir, "profile");
    const openclawDir = path.join(profile, ".openclaw");
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(configPath, "{}", "utf-8");

    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", profile);

    expect(resolveOpenClawConfigPath()).toBe(configPath);
    expect(resolveOpenClawStateDir(undefined)).toBe(openclawDir);
  });
});
