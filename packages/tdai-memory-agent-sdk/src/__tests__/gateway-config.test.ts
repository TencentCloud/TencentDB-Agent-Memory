import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureDefaultGatewayConfig,
  parseGatewayUrl,
  resolveGatewayDefaults,
  validateExistingGatewayConfig,
} from "../gateway/config.js";

describe("gateway config defaults", () => {
  it("uses ~/.tdai-memory/<agent-sdk-name> and per-sdk default ports", () => {
    const codex = resolveGatewayDefaults({ agentSdkName: "codex-sdk" });
    expect(codex.gatewayUrl).toBe("http://127.0.0.1:8420");
    expect(codex.paths.rootDir).toBe(path.join(os.homedir(), ".tdai-memory", "codex-sdk"));
    expect(codex.paths.configPath.endsWith("tdai-gateway.yaml")).toBe(true);

    const claude = resolveGatewayDefaults({ agentSdkName: "claude-code-sdk" });
    expect(claude.gatewayUrl).toBe("http://127.0.0.1:8421");
    expect(claude.paths.rootDir).toBe(path.join(os.homedir(), ".tdai-memory", "claude-code-sdk"));
  });

  it("renders an Ollama-backed config without overwriting an existing file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-agent-sdk-config-"));
    const configPath = path.join(root, "tdai-gateway.yaml");
    const dataDir = path.join(root, "data");

    ensureDefaultGatewayConfig({
      configPath,
      dataDir,
      host: "127.0.0.1",
      port: 8420,
    });
    const first = fs.readFileSync(configPath, "utf-8");
    expect(first).toContain('model: "gemma4:latest"');
    expect(first).toContain('model: "bge-m3:latest"');
    expect(first).toContain("sendDimensions: false");
    expect(first).toContain(`baseDir: "${dataDir}"`);

    fs.writeFileSync(configPath, "sentinel", "utf-8");
    ensureDefaultGatewayConfig({
      configPath,
      dataDir,
      host: "127.0.0.1",
      port: 8420,
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe("sentinel");
  });

  it("fails fast when an existing config points at another port or data dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-agent-sdk-conflict-"));
    const configPath = path.join(root, "tdai-gateway.yaml");
    fs.writeFileSync(configPath, [
      "server:",
      "  port: 9999",
      "data:",
      '  baseDir: "/tmp/other"',
      "",
    ].join("\n"));

    const result = validateExistingGatewayConfig({
      configPath,
      dataDir: path.join(root, "data"),
      port: 8420,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("server.port expected 8420, actual 9999");
    expect(result.message).toContain("data.baseDir expected");
  });

  it("normalizes Gateway URLs", () => {
    expect(parseGatewayUrl("http://127.0.0.1:8420/")).toEqual({
      url: "http://127.0.0.1:8420",
      host: "127.0.0.1",
      port: 8420,
    });
  });
});
