import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig, loadYamlConfig, normalizeWebPublicBaseUrl } from "../../config.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function generateConfig(externalUrl?: string, publicBaseUrl?: string) {
  const directory = mkdtempSync(join(tmpdir(), "proxy-deployment-test-"));
  temporaryDirectories.push(directory);
  const envFile = join(directory, ".env");
  writeFileSync(envFile, "");
  writeFileSync(join(directory, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$1" in
  ps) printf 'tdai-memory-core\\ntdai-memory-hub\\n' ;;
  inspect)
    if [[ "$3" == *State.Status* ]]; then printf 'running\\n'; else printf 'healthy\\n'; fi ;;
esac
`, { mode: 0o700 });
  const environment = {
    PATH: `${directory}:${process.env.PATH}`,
    HOME: directory,
    ENV_FILE: envFile,
    DOCKER_CALLS: join(directory, "docker-calls"),
    PROXY_CONFIG_DIR: directory,
    PROXY_IMAGE: "local/proxy:test",
    PROXY_PORT: "18096",
    PROXY_UPSTREAM_URL: "https://upstream.example/v1",
    PROXY_UPSTREAM_API_KEY: "test-upstream-key",
    PROXY_UPSTREAM_MODEL: "test-model",
    MEMORY_HUB_PROXY_PUBLIC_URL: "https://panel-display.example",
    ...(externalUrl === undefined ? {} : { PROXY_EXTERNAL_GATEWAY_URL: externalUrl }),
    ...(publicBaseUrl === undefined ? {} : { PROXY_SESSION_INIT_PUBLIC_BASE_URL: publicBaseUrl }),
  };
  const run = () => execFileSync("bash", [join(repository, "deploy/global-images/start-proxy.sh")], {
    env: environment,
    encoding: "utf8",
    stdio: "pipe",
  });
  return { directory, run, configPath: join(directory, "config.yaml") };
}

describe("部署脚本的主动工具地址配置", () => {
  it.each([null, true, 8096, {}, []])("手写配置的非字符串浏览器地址不静默回退：%s", (value) => {
    expect(() => normalizeWebPublicBaseUrl(value)).toThrow("sessionInit.webPublicBaseUrl");
  });

  it.each([undefined, "", "https://memory.example.com", "https://memory.example.com/proxy///"])("浏览器地址独立生成并经配置加载器规范化：%s", (publicBaseUrl) => {
    const generated = generateConfig("http://agent-tools:8096", publicBaseUrl);
    generated.run();
    const config = buildConfig({ configFile: generated.configPath });
    expect(config.sessionInit.webPublicBaseUrl).toBe(publicBaseUrl?.replace(/\/+$/, "") || undefined);
    expect(config.injection.externalGatewayUrl).toBe("http://agent-tools:8096");
    if (!publicBaseUrl) expect(loadYamlConfig(generated.configPath).sessionInit).not.toHaveProperty("webPublicBaseUrl");
  });

  it.each([
    "ftp://memory.example.com", "javascript:alert(1)", "https://user@memory.example.com",
    "https://user:password@memory.example.com", "https://memory.example.com?key=secret",
    "https://memory.example.com#fragment", "https://memory.example.com?", "https://memory.example.com#",
    "https:///missing-host", "https://memory.example.com\ninvalid: true",
  ])("部署入口及手写 YAML 都拒绝非法浏览器地址且不回显：%s", (publicBaseUrl) => {
    const generated = generateConfig(undefined, publicBaseUrl);
    expect(generated.run).toThrow();
    expect(() => readFileSync(join(generated.directory, "docker-calls"))).toThrow();
    writeFileSync(generated.configPath, JSON.stringify({ sessionInit: { webPublicBaseUrl: publicBaseUrl } }));
    expect(() => buildConfig({ configFile: generated.configPath })).toThrow("sessionInit.webPublicBaseUrl");
    try { buildConfig({ configFile: generated.configPath }); } catch (error) {
      expect(String(error)).not.toContain(publicBaseUrl);
    }
  });

  it.each([undefined, ""])("未配置或留空时省略字段，保留原有 fallback：%s", (externalUrl) => {
    const generated = generateConfig(externalUrl);
    generated.run();
    expect(loadYamlConfig(generated.configPath).injection).not.toHaveProperty("externalGatewayUrl");
    expect(buildConfig({ configFile: generated.configPath }).injection.externalGatewayUrl).toBeUndefined();
  });

  it.each([
    "http://localhost:18096",
    "http://192.168.1.100:8096",
    "https://memory.example.com",
    "http://proxy:8096",
    "http://[::1]:18096",
    "https://memory.example.com/proxy/",
    "https://memory.example.com/proxy%27s",
  ])("将显式地址作为 YAML 字符串传入既有配置加载器：%s", (externalUrl) => {
    const generated = generateConfig(externalUrl);
    generated.run();
    expect(loadYamlConfig(generated.configPath).injection?.externalGatewayUrl).toBe(externalUrl);
    const config = buildConfig({ configFile: generated.configPath });
    expect(config.injection.externalGatewayUrl).toBe(externalUrl.replace(/\/$/, ""));
    expect(config.injection.injectors).toEqual(["skill", "knowledge", "tdai-memory"]);
    expect(config.upstream.url).toContain("upstream.example");
  });

  it.each([
    "proxy:8096", "file:///etc/passwd", "https://", "https:///missing-host",
    "https://user:secret@proxy.example", "https://proxy.example?token=secret",
    "https://proxy.example#secret", "https://proxy.example\ninjected: true",
    "https://proxy.example/path with space", "https://proxy.example\\path",
    "https://proxy.example/proxy's", "https://proxy.example/$(whoami)",
    "https://proxy.example/`whoami`", "https://proxy.example/;whoami",
  ])("在操作 Docker 前拒绝无效或携带凭据的地址：%s", (externalUrl) => {
    const generated = generateConfig(externalUrl);
    expect(generated.run).toThrow();
    expect(() => readFileSync(join(generated.directory, "docker-calls"))).toThrow();
  });
});
