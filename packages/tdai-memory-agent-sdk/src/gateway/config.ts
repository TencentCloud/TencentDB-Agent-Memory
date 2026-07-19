import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSdkName, MemoryPaths } from "../types.js";

const DEFAULT_PORTS: Record<AgentSdkName, number> = {
  "codex-sdk": 8420,
  "claude-code-sdk": 8421,
};

export interface ResolvedGatewayDefaults {
  gatewayUrl: string;
  host: string;
  port: number;
  paths: MemoryPaths;
  gatewayCwd: string;
}

export interface ResolveGatewayDefaultsOptions {
  agentSdkName: AgentSdkName;
  gatewayUrl?: string;
  rootDir?: string;
  dataDir?: string;
  configPath?: string;
  logDir?: string;
  runtimeDir?: string;
  gatewayCwd?: string;
}

export interface GatewayConfigValidationResult {
  ok: boolean;
  expected: {
    port: number;
    dataDir: string;
  };
  actual: {
    port?: number;
    dataDir?: string;
  };
  message?: string;
}

export function resolveGatewayDefaults(options: ResolveGatewayDefaultsOptions): ResolvedGatewayDefaults {
  const rootDir = expandHome(options.rootDir ?? path.join(os.homedir(), ".tdai-memory", options.agentSdkName));
  const dataDir = expandHome(options.dataDir ?? path.join(rootDir, "data"));
  const configPath = expandHome(options.configPath ?? path.join(rootDir, "tdai-gateway.yaml"));
  const logDir = expandHome(options.logDir ?? path.join(rootDir, "logs"));
  const runtimeDir = expandHome(options.runtimeDir ?? path.join(rootDir, "runtime"));
  const parsed = parseGatewayUrl(
    options.gatewayUrl ?? `http://127.0.0.1:${DEFAULT_PORTS[options.agentSdkName]}`,
  );

  return {
    gatewayUrl: parsed.url,
    host: parsed.host,
    port: parsed.port,
    paths: {
      rootDir,
      configPath,
      dataDir,
      logDir,
      runtimeDir,
    },
    gatewayCwd: expandHome(options.gatewayCwd ?? resolveRepoRoot()),
  };
}

export function ensureDefaultGatewayConfig(options: {
  configPath: string;
  dataDir: string;
  host: string;
  port: number;
  apiKey?: string;
}): void {
  fs.mkdirSync(path.dirname(options.configPath), { recursive: true });
  fs.mkdirSync(options.dataDir, { recursive: true });
  if (fs.existsSync(options.configPath)) return;

  fs.writeFileSync(options.configPath, renderDefaultGatewayYaml(options), "utf-8");
}

export function validateExistingGatewayConfig(options: {
  configPath: string;
  dataDir: string;
  port: number;
}): GatewayConfigValidationResult {
  if (!fs.existsSync(options.configPath)) {
    return {
      ok: true,
      expected: { port: options.port, dataDir: normalizePath(options.dataDir) },
      actual: {},
    };
  }

  const raw = fs.readFileSync(options.configPath, "utf-8");
  const actualPort = readYamlNumber(raw, ["server", "port"]);
  const actualDataDir = readYamlString(raw, ["data", "baseDir"]);
  const expectedDataDir = normalizePath(options.dataDir);
  const normalizedActualDataDir = actualDataDir ? normalizePath(expandHome(actualDataDir)) : undefined;

  const mismatches: string[] = [];
  if (actualPort !== undefined && actualPort !== options.port) {
    mismatches.push(`server.port expected ${options.port}, actual ${actualPort}`);
  }
  if (normalizedActualDataDir !== undefined && normalizedActualDataDir !== expectedDataDir) {
    mismatches.push(`data.baseDir expected ${expectedDataDir}, actual ${normalizedActualDataDir}`);
  }

  if (mismatches.length === 0) {
    return {
      ok: true,
      expected: { port: options.port, dataDir: expectedDataDir },
      actual: { port: actualPort, dataDir: normalizedActualDataDir },
    };
  }

  return {
    ok: false,
    expected: { port: options.port, dataDir: expectedDataDir },
    actual: { port: actualPort, dataDir: normalizedActualDataDir },
    message: [
      `Existing Gateway config ${options.configPath} conflicts with this SDK instance.`,
      ...mismatches.map((item) => `- ${item}`),
      "Fix: pass matching gatewayUrl/dataDir/configPath, edit the config, or use a separate rootDir.",
    ].join("\n"),
  };
}

export function renderDefaultGatewayYaml(options: {
  dataDir: string;
  host: string;
  port: number;
  apiKey?: string;
}): string {
  const apiKeyLine = options.apiKey ? `  apiKey: "${yamlQuote(options.apiKey)}"\n` : "";
  return `server:
  host: "${yamlQuote(options.host)}"
  port: ${options.port}
${apiKeyLine}  corsOrigins: []

data:
  baseDir: "${yamlQuote(options.dataDir)}"

llm:
  baseUrl: "http://127.0.0.1:11434/v1"
  apiKey: "ollama"
  model: "gemma4:latest"
  maxTokens: 4096
  timeoutMs: 120000
  disableThinking: false

memory:
  timezone: "Asia/Shanghai"
  storeBackend: "sqlite"

  capture:
    enabled: true

  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20

  pipeline:
    everyNConversations: 1
    enableWarmup: false
    l1IdleTimeoutSeconds: 3
    l2DelayAfterL1Seconds: 2
    l2MinIntervalSeconds: 5
    l2MaxIntervalSeconds: 30
    sessionActiveWindowHours: 24

  recall:
    enabled: true
    strategy: "hybrid"
    maxResults: 5
    scoreThreshold: 0.1
    timeoutMs: 10000

  embedding:
    enabled: true
    provider: "openai"
    baseUrl: "http://127.0.0.1:11434/v1"
    apiKey: "ollama"
    model: "bge-m3:latest"
    dimensions: 1024
    sendDimensions: false
    timeoutMs: 30000
    recallTimeoutMs: 10000
    captureTimeoutMs: 30000

  persona:
    triggerEveryN: 50
    maxScenes: 15

  report:
    enabled: false

  offload:
    enabled: false
`;
}

export function parseGatewayUrl(gatewayUrl: string): { url: string; host: string; port: number } {
  const url = new URL(gatewayUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported gatewayUrl protocol: ${url.protocol}`);
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid gatewayUrl port: ${gatewayUrl}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return {
    url: url.toString().replace(/\/$/, ""),
    host: url.hostname,
    port,
  };
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..");
}

function yamlQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizePath(value: string): string {
  return path.resolve(expandHome(value));
}

function readYamlNumber(raw: string, pathParts: [string, string]): number | undefined {
  const value = readYamlScalar(raw, pathParts);
  if (value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function readYamlString(raw: string, pathParts: [string, string]): string | undefined {
  const value = readYamlScalar(raw, pathParts);
  if (value === undefined) return undefined;
  return unquote(value.trim());
}

function readYamlScalar(raw: string, [section, key]: [string, string]): string | undefined {
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      inSection = line.slice(0, -1).trim() === section;
      continue;
    }
    if (!inSection) continue;
    const match = new RegExp(`^\\s+${escapeRegExp(key)}:\\s*(.*?)\\s*(?:#.*)?$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
