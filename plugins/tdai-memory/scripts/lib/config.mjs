import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "tdai-memory",
  "openai-plugin.json",
);

export const DEFAULT_CONFIG = Object.freeze({
  gatewayUrl: "http://127.0.0.1:8420",
  memoryProxyUrl: "http://127.0.0.1:8096",
  mcpBinary: "memory-tencentdb-mcp",
  mcpArgs: [],
});

export const REPO_MCP_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../MemoryCore/dist/memory-tencentdb-mcp.mjs",
);

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeUrl(value, field, allowRemote) {
  const raw = requireString(value, field);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new Error(`${field} is not a valid URL: ${cause.message}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${field} must use http or https`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${field} must not contain credentials, a query, or a fragment`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!allowRemote && !loopback) {
    throw new Error(`${field} is remote; pass --allow-remote only for a trusted endpoint`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function validateConfig(input, { allowRemote = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("configuration must be a JSON object");
  }
  const args = input.mcpArgs ?? [];
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    throw new Error("mcpArgs must be an array of strings");
  }
  return {
    gatewayUrl: normalizeUrl(input.gatewayUrl, "gatewayUrl", allowRemote),
    memoryProxyUrl: normalizeUrl(input.memoryProxyUrl, "memoryProxyUrl", allowRemote),
    mcpBinary: requireString(input.mcpBinary, "mcpBinary"),
    mcpArgs: args,
  };
}

export function resolveConfigPath(explicitPath) {
  return path.resolve(
    explicitPath
      ?? process.env.TDAI_OPENAI_PLUGIN_CONFIG
      ?? DEFAULT_CONFIG_PATH,
  );
}

export async function loadConfig({ configPath, allowRemote = false } = {}) {
  const resolvedPath = resolveConfigPath(configPath);
  try {
    await access(resolvedPath);
  } catch {
    return {
      config: validateConfig(DEFAULT_CONFIG, { allowRemote }),
      configPath: resolvedPath,
      source: "defaults",
    };
  }
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  return {
    config: validateConfig({ ...DEFAULT_CONFIG, ...parsed }, { allowRemote }),
    configPath: resolvedPath,
    source: "file",
  };
}

export function resolveMcpArgs(args, workingDirectory = process.cwd()) {
  return args.map((argument) => {
    if (!argument.startsWith("./") && !argument.startsWith("../")) return argument;
    return path.resolve(workingDirectory, argument);
  });
}

export async function resolveMcpCommand(config, explicitBinary) {
  if (explicitBinary) return { command: explicitBinary, args: [], source: "environment" };
  try {
    await access(REPO_MCP_ENTRY);
    return { command: process.execPath, args: [REPO_MCP_ENTRY], source: "repository-build" };
  } catch {
    return {
      command: config.mcpBinary,
      args: resolveMcpArgs(config.mcpArgs),
      source: "installed-package",
    };
  }
}
