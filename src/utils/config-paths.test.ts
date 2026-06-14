import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const osState = vi.hoisted(() => ({
  homedirMock: vi.fn<typeof import("node:os").homedir>(),
  userInfoMock: vi.fn<typeof import("node:os").userInfo>(),
  actualHomedir: null as typeof import("node:os").homedir | null,
  actualUserInfo: null as typeof import("node:os").userInfo | null,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  osState.actualHomedir = actual.homedir;
  osState.actualUserInfo = actual.userInfo;
  osState.homedirMock.mockImplementation(actual.homedir);
  osState.userInfoMock.mockImplementation(actual.userInfo);
  return {
    ...actual,
    homedir: osState.homedirMock,
    userInfo: osState.userInfoMock,
  };
});

import { loadGatewayConfig } from "../gateway/config.js";
import {
  _resetConfigPathWarningsForTest,
  candidateAppConfigFiles,
  optionalConfigFileExists,
  resolveHomeDir,
} from "./config-paths.js";

describe("config path helpers", () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    _resetConfigPathWarningsForTest();
    if (osState.actualHomedir) osState.homedirMock.mockImplementation(osState.actualHomedir);
    if (osState.actualUserInfo) osState.userInfoMock.mockImplementation(osState.actualUserInfo);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses XDG_CONFIG_HOME for Linux app config paths", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/tmp/xdg-config");

    expect(candidateAppConfigFiles("memory-tencentdb", ["tdai-gateway.json"], "/home/alice", "linux")).toEqual([
      path.join("/tmp/xdg-config", "memory-tencentdb", "tdai-gateway.json"),
    ]);
  });

  it("falls back to ~/.config for Linux app config paths", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "");

    expect(candidateAppConfigFiles("memory-tencentdb", ["tdai-gateway.yaml"], "/home/alice", "linux")).toEqual([
      path.join("/home/alice", ".config", "memory-tencentdb", "tdai-gateway.yaml"),
    ]);
  });

  it("resolveHomeDir prefers os.homedir when HOME and USERPROFILE are unset", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    osState.homedirMock.mockReturnValue("/home/alice");

    expect(resolveHomeDir()).toBe("/home/alice");
  });

  it("resolveHomeDir prefers USERPROFILE when HOME is unset", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "/profile/home");
    osState.homedirMock.mockReturnValue("/passwd/home");

    expect(resolveHomeDir()).toBe("/profile/home");
  });

  it("resolveHomeDir falls back to /tmp when homedir and userInfo are empty", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    osState.homedirMock.mockReturnValue("");
    osState.userInfoMock.mockImplementation(() => {
      throw new Error("no passwd entry");
    });

    expect(resolveHomeDir()).toBe("/tmp");
  });

  it("loadGatewayConfig keeps config and data under the same resolved home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tdai-home-consistency-"));
    tempDirs.push(root);

    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const configDir = path.join(home, ".config", "memory-tencentdb");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 9462 }, llm: { model: "from-xdg-config" } }),
      "utf-8",
    );

    process.chdir(cwd);
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("TDAI_DATA_DIR", undefined as unknown as string);
    vi.stubEnv("TDAI_GATEWAY_CONFIG", undefined as unknown as string);
    vi.stubEnv("MEMORY_TENCENTDB_ROOT", undefined as unknown as string);
    osState.homedirMock.mockReturnValue(home);

    const cfg = loadGatewayConfig();

    expect(cfg.server.port).toBe(9462);
    expect(cfg.llm.model).toBe("from-xdg-config");
    expect(cfg.data.baseDir).toBe(path.join(home, ".memory-tencentdb", "memory-tdai"));
  });

  it("can warn only once for missing optional config files", () => {
    const missing = path.join(os.tmpdir(), `memory-tdai-missing-${Date.now()}`, "missing.json");
    const warnings: string[] = [];

    expect(optionalConfigFileExists(missing, {
      missingLogLevel: "warn",
      logger: { warn: (msg) => warnings.push(msg) },
    })).toBe(false);
    expect(optionalConfigFileExists(missing, {
      missingLogLevel: "warn",
      logger: { warn: (msg) => warnings.push(msg) },
    })).toBe(false);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("optional config file missing, skipped");
  });

  it("loads gateway config from the Linux XDG config directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tdai-xdg-"));
    tempDirs.push(root);

    const cwd = path.join(root, "cwd");
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    const configDir = path.join(xdg, "memory-tencentdb");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "tdai-gateway.json"),
      JSON.stringify({ server: { port: 9461 }, llm: { model: "from-xdg-config" } }),
      "utf-8",
    );

    process.chdir(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    vi.stubEnv("TDAI_DATA_DIR", undefined as unknown as string);
    vi.stubEnv("TDAI_GATEWAY_CONFIG", undefined as unknown as string);

    const cfg = loadGatewayConfig();

    expect(cfg.server.port).toBe(9461);
    expect(cfg.llm.model).toBe("from-xdg-config");
  });
});
