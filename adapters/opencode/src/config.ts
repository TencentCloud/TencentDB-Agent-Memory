import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AdapterConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  stateDir: string;
  timeoutMs: number;
  recallLimit: number;
  maxContextChars: number;
  maxMessageChars: number;
  maxSkillBytes: number;
  recallEnabled: boolean;
  captureEnabled: boolean;
  skillEnabled: boolean;
  allowInsecureHttp: boolean;
}

export type ConfigResult = { ok: true; value: AdapterConfig } | { ok: false; errors: string[] };
type Environment = Record<string, string | undefined>;

export const GATEWAY_MAX_MESSAGE_CHARS = 8_192;

const fileKeys = {
  endpoint: "TDAI_MEMORY_ENDPOINT",
  apiKey: "TDAI_MEMORY_API_KEY",
  serviceId: "TDAI_MEMORY_SERVICE_ID",
  teamId: "TDAI_MEMORY_TEAM_ID",
  agentId: "TDAI_MEMORY_AGENT_ID",
  userId: "TDAI_MEMORY_USER_ID",
  taskId: "TDAI_MEMORY_TASK_ID",
  stateDir: "TDAI_OPENCODE_STATE_DIR",
  timeoutMs: "TDAI_OPENCODE_TIMEOUT_MS",
  recallLimit: "TDAI_OPENCODE_RECALL_LIMIT",
  maxContextChars: "TDAI_OPENCODE_MAX_CONTEXT_CHARS",
  maxMessageChars: "TDAI_OPENCODE_MAX_MESSAGE_CHARS",
  maxSkillBytes: "TDAI_OPENCODE_MAX_SKILL_BYTES",
  recallEnabled: "TDAI_OPENCODE_RECALL_ENABLED",
  captureEnabled: "TDAI_OPENCODE_CAPTURE_ENABLED",
  skillEnabled: "TDAI_OPENCODE_SKILL_ENABLED",
  allowInsecureHttp: "TDAI_OPENCODE_ALLOW_INSECURE_HTTP",
} as const;

const localDefaults = {
  apiKey: "local",
  serviceId: "default",
  teamId: "default",
  agentId: "opencode",
  userId: "default",
} as const;

function bool(value: string | undefined, fallback: boolean, key: string, errors: string[]): boolean {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  errors.push(`${key} must be a boolean (true/false, yes/no, on/off, or 1/0)`);
  return fallback;
}

function integer(env: Environment, key: string, fallback: number, min: number, max: number, errors: string[]): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${key} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return parsed;
}

function loopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

function safeId(name: string, value: string | undefined, errors: string[]): string {
  const id = value?.trim() ?? "";
  if (!id) return id;
  if (id.includes("|")) errors.push(`${name} must not contain |`);
  return id;
}

function configPath(env: Environment): string {
  const configured = env.TDAI_OPENCODE_CONFIG_FILE?.trim();
  if (configured) return resolve(configured);
  const root = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(root, "opencode", "tencentdb-agent-memory.json");
}

function fileEnvironment(env: Environment, errors: string[]): Environment {
  const path = configPath(env);
  if (!existsSync(path)) {
    if (env.TDAI_OPENCODE_CONFIG_FILE?.trim()) errors.push(`TDAI_OPENCODE_CONFIG_FILE does not exist: ${path}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be a JSON object");
    const record = parsed as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !(key in fileKeys));
    if (unknown.length > 0) errors.push(`Unknown config file field(s): ${unknown.join(", ")}`);
    const result: Environment = {};
    for (const [key, envName] of Object.entries(fileKeys)) {
      const value = record[key];
      if (value === undefined || value === null) continue;
      if (!["string", "number", "boolean"].includes(typeof value)) {
        errors.push(`Config file field ${key} must be a string, number, or boolean`);
        continue;
      }
      result[envName] = String(value);
    }
    return result;
  } catch (error) {
    errors.push(`Cannot read config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function loadConfig(env: Environment = process.env): ConfigResult {
  const errors: string[] = [];
  const merged = { ...fileEnvironment(env, errors), ...env };

  const allowInsecureHttp = bool(
    merged.TDAI_OPENCODE_ALLOW_INSECURE_HTTP,
    false,
    "TDAI_OPENCODE_ALLOW_INSECURE_HTTP",
    errors,
  );
  let endpoint = (merged.TDAI_MEMORY_ENDPOINT?.trim() || "http://127.0.0.1:8420").replace(/\/+$/, "");
  let isLocal = false;
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol)) errors.push("TDAI_MEMORY_ENDPOINT must use http or https");
    if (url.username || url.password) errors.push("TDAI_MEMORY_ENDPOINT must not contain credentials");
    if (url.search || url.hash) errors.push("TDAI_MEMORY_ENDPOINT must not contain query parameters or a fragment");
    if (url.protocol === "http:" && !loopback(url.hostname) && !allowInsecureHttp) {
      errors.push("Remote HTTP exposes the bearer token; use HTTPS or explicitly allow insecure HTTP");
    }
    isLocal = loopback(url.hostname);
    endpoint = url.toString().replace(/\/+$/, "");
  } catch {
    errors.push("TDAI_MEMORY_ENDPOINT must be a valid URL");
  }

  const explicit = {
    apiKey: merged.TDAI_MEMORY_API_KEY?.trim(),
    serviceId: merged.TDAI_MEMORY_SERVICE_ID?.trim(),
    teamId: merged.TDAI_MEMORY_TEAM_ID?.trim(),
    agentId: merged.TDAI_MEMORY_AGENT_ID?.trim(),
    userId: merged.TDAI_MEMORY_USER_ID?.trim(),
  };
  if (!isLocal) {
    for (const [name, value] of Object.entries(explicit)) {
      if (!value) errors.push(`Remote Gateway requires explicit ${name}`);
    }
  }
  const serviceId = safeId("TDAI_MEMORY_SERVICE_ID", explicit.serviceId || localDefaults.serviceId, errors);
  const teamId = safeId("TDAI_MEMORY_TEAM_ID", explicit.teamId || localDefaults.teamId, errors);
  const agentId = safeId("TDAI_MEMORY_AGENT_ID", explicit.agentId || localDefaults.agentId, errors);
  const userId = safeId("TDAI_MEMORY_USER_ID", explicit.userId || localDefaults.userId, errors);
  const taskId = merged.TDAI_MEMORY_TASK_ID?.trim() || undefined;
  if (taskId?.includes("|")) errors.push("TDAI_MEMORY_TASK_ID must not contain |");
  if (taskId && taskId.length > 128) errors.push("TDAI_MEMORY_TASK_ID must be at most 128 characters");

  const stateRoot = merged.TDAI_OPENCODE_STATE_DIR?.trim()
    || join(merged.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "opencode", "tencentdb-agent-memory");

  const value: AdapterConfig = {
    endpoint,
    apiKey: explicit.apiKey || localDefaults.apiKey,
    serviceId,
    teamId,
    agentId,
    userId,
    ...(taskId ? { taskId } : {}),
    stateDir: resolve(stateRoot),
    timeoutMs: integer(merged, "TDAI_OPENCODE_TIMEOUT_MS", 5_000, 100, 60_000, errors),
    recallLimit: integer(merged, "TDAI_OPENCODE_RECALL_LIMIT", 5, 1, 20, errors),
    maxContextChars: integer(merged, "TDAI_OPENCODE_MAX_CONTEXT_CHARS", 8_000, 500, 64_000, errors),
    maxMessageChars: integer(
      merged,
      "TDAI_OPENCODE_MAX_MESSAGE_CHARS",
      GATEWAY_MAX_MESSAGE_CHARS,
      500,
      GATEWAY_MAX_MESSAGE_CHARS,
      errors,
    ),
    maxSkillBytes: integer(merged, "TDAI_OPENCODE_MAX_SKILL_BYTES", 480_000, 10_000, 1_000_000, errors),
    recallEnabled: bool(merged.TDAI_OPENCODE_RECALL_ENABLED, true, "TDAI_OPENCODE_RECALL_ENABLED", errors),
    captureEnabled: bool(merged.TDAI_OPENCODE_CAPTURE_ENABLED, true, "TDAI_OPENCODE_CAPTURE_ENABLED", errors),
    skillEnabled: bool(merged.TDAI_OPENCODE_SKILL_ENABLED, false, "TDAI_OPENCODE_SKILL_ENABLED", errors),
    allowInsecureHttp,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export function publicConfig(config: AdapterConfig): Record<string, unknown> {
  return {
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
    isolationConfigured: Boolean(config.serviceId && config.teamId && config.agentId && config.userId),
    taskConfigured: Boolean(config.taskId),
    recallEnabled: config.recallEnabled,
    captureEnabled: config.captureEnabled,
    skillEnabled: config.skillEnabled,
  };
}
