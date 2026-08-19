import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AdapterConfigFile,
  ConfigResult,
  LoadedConfig,
  RecallConfigFile,
  RecallOptions,
  SkillsConfigFile,
  SkillsOptions,
} from "./types.js";

export const CONFIG_FILE_NAME = "tdai-memory.json";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8420";
const DEFAULT_SERVICE_ID = "default";
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_SECRET_FILE_BYTES = 16 * 1024;
const DEFAULT_RECALL: RecallOptions = {
  enabled: true,
  deadlineMs: 3_000,
  l0Limit: 4,
  l1Limit: 6,
  l2Limit: 2,
  maxChars: 12_000,
};

// Skills are opt-in: absent `skills` or `skills.enabled=false` keeps today's
// L0-L3 behaviour unchanged. When enabled, capture defaults on but the runtime
// read tools and team-wide search stay gated by the sub-flags below.
const DEFAULT_SKILLS: SkillsOptions = {
  enabled: false,
  capture: true,
  runtimeTools: true,
  routingMode: "bm25",
  allowTeamSearch: false,
  includeFailedTools: false,
  maxMessageBytes: 32_768,
  maxToolItems: 16,
  flushTimeoutMs: 1_500,
};

export interface LoadConfigOptions {
  cwd: string;
  projectTrusted: boolean;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  configDirName?: string;
}

interface PartialWithOrigin {
  values: AdapterConfigFile;
  path: string;
  scope: "global" | "project";
}

type ConfigKey = keyof AdapterConfigFile;

interface MergedConfig {
  values: AdapterConfigFile;
  origins: Partial<Record<ConfigKey, string>>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateConfigObject(value: object, path: string): AdapterConfigFile {
  const input = value as Record<string, unknown>;
  const output: AdapterConfigFile = {};

  const assignNumber = (key: "schemaVersion" | "timeoutMs") => {
    const candidate = input[key];
    if (candidate === undefined) return;
    if (typeof candidate !== "number") throw new Error(`${key} in ${path} must be a number`);
    output[key] = candidate;
  };
  const assignBoolean = (key: "enabled" | "rejectUnauthorized" | "captureTools" | "allowProjectConfig") => {
    const candidate = input[key];
    if (candidate === undefined) return;
    if (typeof candidate !== "boolean") throw new Error(`${key} in ${path} must be a boolean`);
    output[key] = candidate;
  };
  const assignString = (
    key: "endpoint" | "serviceId" | "teamId" | "agentId" | "userId" | "userKeyFile" | "gatewayApiKeyFile",
  ) => {
    const candidate = input[key];
    if (candidate === undefined) return;
    if (typeof candidate !== "string") throw new Error(`${key} in ${path} must be a string`);
    output[key] = candidate;
  };

  assignNumber("schemaVersion");
  assignNumber("timeoutMs");
  assignBoolean("enabled");
  assignBoolean("rejectUnauthorized");
  assignBoolean("captureTools");
  assignBoolean("allowProjectConfig");
  assignString("endpoint");
  assignString("serviceId");
  assignString("teamId");
  assignString("agentId");
  assignString("userId");
  assignString("userKeyFile");
  assignString("gatewayApiKeyFile");
  if (input.recall !== undefined) {
    if (!input.recall || typeof input.recall !== "object" || Array.isArray(input.recall)) {
      throw new Error(`recall in ${path} must be an object`);
    }
    output.recall = validateRecallConfig(input.recall as Record<string, unknown>, path);
  }
  if (input.skills !== undefined) {
    if (!input.skills || typeof input.skills !== "object" || Array.isArray(input.skills)) {
      throw new Error(`skills in ${path} must be an object`);
    }
    output.skills = validateSkillsConfig(input.skills as Record<string, unknown>, path);
  }
  return output;
}

function validateRecallConfig(input: Record<string, unknown>, path: string): RecallConfigFile {
  const result: RecallConfigFile = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error(`recall.enabled in ${path} must be a boolean`);
    result.enabled = input.enabled;
  }
  for (const key of ["deadlineMs", "l0Limit", "l1Limit", "l2Limit", "maxChars"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "number") throw new Error(`recall.${key} in ${path} must be a number`);
    result[key] = input[key];
  }
  return result;
}

function validateSkillsConfig(input: Record<string, unknown>, path: string): SkillsConfigFile {
  const result: SkillsConfigFile = {};
  for (const key of ["enabled", "capture", "runtimeTools", "allowTeamSearch", "includeFailedTools"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new Error(`skills.${key} in ${path} must be a boolean`);
    result[key] = input[key];
  }
  if (input.routingMode !== undefined) {
    if (input.routingMode !== "bm25" && input.routingMode !== "embedding" && input.routingMode !== "hybrid") {
      throw new Error(`skills.routingMode in ${path} must be one of bm25, embedding, hybrid`);
    }
    result.routingMode = input.routingMode;
  }
  for (const key of ["maxMessageBytes", "maxToolItems", "flushTimeoutMs"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "number") throw new Error(`skills.${key} in ${path} must be a number`);
    result[key] = input[key];
  }
  return result;
}

async function readConfigFile(path: string, scope: PartialWithOrigin["scope"]): Promise<PartialWithOrigin | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration root must be a JSON object");
    }
    return { values: validateConfigObject(parsed, path), path, scope };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${path}: ${message}`);
  }
}

function resolveReference(path: string, declaringConfig: string): string {
  return isAbsolute(path) ? path : resolve(dirname(declaringConfig), path);
}

export async function readSecretFile(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a directory or symbolic link`);
  }
  if (info.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_SECRET_FILE_BYTES} bytes`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

function mergeSource(target: MergedConfig, source: PartialWithOrigin): void {
  for (const [rawKey, value] of Object.entries(source.values)) {
    if (value === undefined) continue;
    const key = rawKey as ConfigKey;
    if (key === "recall") {
      target.values.recall = { ...target.values.recall, ...(value as RecallConfigFile) };
    } else if (key === "skills") {
      target.values.skills = { ...target.values.skills, ...(value as SkillsConfigFile) };
    } else {
      Object.assign(target.values, { [key]: value });
    }
    target.origins[key] = source.path;
  }
}

/**
 * Pi does not ask for trust merely because a repository contains an arbitrary
 * `.pi/*.json` file. Treat this adapter's project file as untrusted unless the
 * user opted in from their global config, and keep that opt-in deliberately
 * narrow: project authors may tune recall only, never route credentials.
 */
function mergeProjectRecallOnly(target: MergedConfig, source: PartialWithOrigin, errors: string[]): void {
  const unsupported = Object.keys(source.values).filter((key) => key !== "recall");
  if (unsupported.length > 0) {
    errors.push(`project configuration may only set recall (unsupported: ${unsupported.sort().join(", ")})`);
  }
  if (source.values.recall !== undefined) {
    target.values.recall = { ...target.values.recall, ...source.values.recall };
    target.origins.recall = source.path;
  }
}

function resolveRecallOptions(value: RecallConfigFile | undefined, errors: string[]): RecallOptions {
  const result: RecallOptions = { ...DEFAULT_RECALL, ...value };
  if (!Number.isInteger(result.deadlineMs) || result.deadlineMs < 100 || result.deadlineMs > 30_000) {
    errors.push("recall.deadlineMs must be an integer between 100 and 30000");
  }
  for (const [key, limit] of Object.entries({
    l0Limit: result.l0Limit,
    l1Limit: result.l1Limit,
    l2Limit: result.l2Limit,
  })) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 20) {
      errors.push(`recall.${key} must be an integer between 0 and 20`);
    }
  }
  if (!Number.isInteger(result.maxChars) || result.maxChars < 1_000 || result.maxChars > 48_000) {
    errors.push("recall.maxChars must be an integer between 1000 and 48000");
  }
  return result;
}

function resolveSkillsOptions(value: SkillsConfigFile | undefined, errors: string[]): SkillsOptions {
  const result: SkillsOptions = { ...DEFAULT_SKILLS, ...value };
  if (!Number.isInteger(result.maxMessageBytes) || result.maxMessageBytes < 1_024 || result.maxMessageBytes > 1_048_576) {
    errors.push("skills.maxMessageBytes must be an integer between 1024 and 1048576");
  }
  if (!Number.isInteger(result.maxToolItems) || result.maxToolItems < 0 || result.maxToolItems > 100) {
    errors.push("skills.maxToolItems must be an integer between 0 and 100");
  }
  if (!Number.isInteger(result.flushTimeoutMs) || result.flushTimeoutMs < 100 || result.flushTimeoutMs > 30_000) {
    errors.push("skills.flushTimeoutMs must be an integer between 100 and 30000");
  }
  return result;
}

function applyEnv(target: MergedConfig, env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];
  const setString = (key: ConfigKey, name: string) => {
    const value = nonEmpty(env[name]);
    if (value === undefined) return;
    Object.assign(target.values, { [key]: value });
    target.origins[key] = `environment variable ${name}`;
  };

  setString("endpoint", "TDAI_MEMORY_ENDPOINT");
  setString("serviceId", "TDAI_MEMORY_SERVICE_ID");
  setString("teamId", "TDAI_MEMORY_TEAM_ID");
  setString("agentId", "TDAI_MEMORY_AGENT_ID");
  setString("userId", "TDAI_MEMORY_USER_ID");
  setString("userKeyFile", "TDAI_MEMORY_USER_KEY_FILE");
  setString("gatewayApiKeyFile", "TDAI_MEMORY_GATEWAY_API_KEY_FILE");

  const timeoutValue = nonEmpty(env.TDAI_MEMORY_TIMEOUT_MS);
  if (timeoutValue !== undefined) {
    target.values.timeoutMs = Number(timeoutValue);
    target.origins.timeoutMs = "environment variable TDAI_MEMORY_TIMEOUT_MS";
  }
  const rejectValue = nonEmpty(env.TDAI_MEMORY_REJECT_UNAUTHORIZED)?.toLowerCase();
  if (rejectValue !== undefined) {
    if (rejectValue !== "true" && rejectValue !== "false") {
      errors.push("TDAI_MEMORY_REJECT_UNAUTHORIZED must be true or false");
    } else {
      target.values.rejectUnauthorized = rejectValue === "true";
      target.origins.rejectUnauthorized = "environment variable TDAI_MEMORY_REJECT_UNAUTHORIZED";
    }
  }
  return errors;
}

export function validateEndpoint(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "endpoint must be a valid HTTP(S) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "endpoint must use HTTP or HTTPS";
  if (url.username || url.password) return "endpoint must not contain username or password";
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) return "remote endpoints must use HTTPS";
  return undefined;
}

export interface GlobalSetupConfig {
  endpoint: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  userKeyFile: string;
  gatewayApiKeyFile?: string;
}

/**
 * Persist only non-secret setup data in Pi's global agent directory. The key
 * itself remains in a user-managed file; this also keeps repository config
 * incapable of routing credentials to a different endpoint.
 */
export async function saveGlobalSetupConfig(config: GlobalSetupConfig, agentDir = getAgentDir()): Promise<string> {
  const path = join(agentDir, CONFIG_FILE_NAME);
  const existing = await readConfigFile(path, "global");
  const next: AdapterConfigFile = {
    ...existing?.values,
    schemaVersion: 1,
    enabled: true,
    endpoint: config.endpoint,
    serviceId: config.serviceId,
    teamId: config.teamId,
    agentId: config.agentId,
    userId: config.userId,
    userKeyFile: config.userKeyFile,
  };
  if (config.gatewayApiKeyFile) next.gatewayApiKeyFile = config.gatewayApiKeyFile;
  else delete next.gatewayApiKeyFile;

  await mkdir(agentDir, { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  return path;
}

function secretPath(value: string, origin: string | undefined, options: LoadConfigOptions): string {
  if (isAbsolute(value)) return value;
  if (origin?.startsWith("environment variable ")) return resolve(options.cwd, value);
  const fallbackConfig = join(options.agentDir ?? getAgentDir(), CONFIG_FILE_NAME);
  return resolveReference(value, origin ?? fallbackConfig);
}

export async function loadConfig(options: LoadConfigOptions): Promise<ConfigResult> {
  const env = options.env ?? process.env;
  const sources: PartialWithOrigin[] = [];
  try {
    const globalPath = join(options.agentDir ?? getAgentDir(), CONFIG_FILE_NAME);
    const globalConfig = await readConfigFile(globalPath, "global");
    if (globalConfig) sources.push(globalConfig);

    const merged: MergedConfig = {
      values: {
        schemaVersion: 1,
        enabled: true,
        endpoint: DEFAULT_ENDPOINT,
        serviceId: DEFAULT_SERVICE_ID,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        rejectUnauthorized: true,
        captureTools: false,
      },
      origins: {},
    };
    if (globalConfig) mergeSource(merged, globalConfig);
    const errors: string[] = [];

    // `ctx.isProjectTrusted()` alone is insufficient for this custom file:
    // Pi treats a bare `.pi/tdai-memory.json` as non-trust-requiring. A global
    // configuration must explicitly opt in before we even parse project data.
    if (options.projectTrusted && globalConfig?.values.allowProjectConfig === true) {
      const projectPath = join(options.cwd, options.configDirName ?? CONFIG_DIR_NAME, CONFIG_FILE_NAME);
      const projectConfig = await readConfigFile(projectPath, "project");
      if (projectConfig) {
        sources.push(projectConfig);
        mergeProjectRecallOnly(merged, projectConfig, errors);
      }
    }
    errors.push(...applyEnv(merged, env));
    const values = merged.values;
    const sourcePaths = sources.map((source) => source.path);
    const recall = resolveRecallOptions(values.recall, errors);
    const skills = resolveSkillsOptions(values.skills, errors);

    if (values.schemaVersion !== 1) errors.push("schemaVersion must be 1");
    if (values.enabled === false && errors.length === 0) {
      return { ok: true, config: { enabled: false, sources: sourcePaths } };
    }

    const endpoint = nonEmpty(values.endpoint) ?? DEFAULT_ENDPOINT;
    const endpointError = validateEndpoint(endpoint);
    if (endpointError) errors.push(endpointError);
    const timeoutMs = values.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      errors.push("timeoutMs must be between 1 and 30000");
    }
    if (values.rejectUnauthorized === false) {
      // The SDK may disable TLS verification process-wide when this is false.
      // Local deployments can use loopback HTTP; remote deployments need a
      // certificate trusted by the operating system.
      errors.push("rejectUnauthorized=false is not supported; use a trusted TLS certificate");
    }

    const serviceId = nonEmpty(values.serviceId) ?? DEFAULT_SERVICE_ID;
    const required = {
      serviceId,
      teamId: nonEmpty(values.teamId),
      agentId: nonEmpty(values.agentId),
      userId: nonEmpty(values.userId),
    };
    for (const [key, value] of Object.entries(required)) {
      if (!value) errors.push(`${key} is required`);
      else if (value.includes("|")) errors.push(`${key} must not contain |`);
    }

    const directUserKey = nonEmpty(env.TDAI_MEMORY_USER_KEY);
    const directGatewayKey = nonEmpty(env.TDAI_MEMORY_GATEWAY_API_KEY);
    let userKey = directUserKey;
    let gatewayApiKey = directGatewayKey;
    let userKeySource = directUserKey ? "environment variable TDAI_MEMORY_USER_KEY" : "";
    let gatewayApiKeySource = directGatewayKey ? "environment variable TDAI_MEMORY_GATEWAY_API_KEY" : "";

    if (!userKey && values.userKeyFile) {
      const path = secretPath(values.userKeyFile, merged.origins.userKeyFile, options);
      try {
        userKey = await readSecretFile(path, "user key file");
        userKeySource = "key file";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        errors.push(code ? `user key file could not be read (${code})` : error instanceof Error ? error.message : String(error));
      }
    }
    if (!gatewayApiKey && values.gatewayApiKeyFile) {
      const path = secretPath(values.gatewayApiKeyFile, merged.origins.gatewayApiKeyFile, options);
      try {
        gatewayApiKey = await readSecretFile(path, "gateway API key file");
        gatewayApiKeySource = "key file";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        errors.push(
          code
            ? `gateway API key file could not be read (${code})`
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    }
    if (!userKey) errors.push("user key is required (TDAI_MEMORY_USER_KEY or userKeyFile)");
    if (!gatewayApiKey && userKey) {
      gatewayApiKey = userKey;
      gatewayApiKeySource = "user key fallback for gateway Bearer";
    }

    if (
      errors.length > 0 ||
      !required.teamId ||
      !required.agentId ||
      !required.userId ||
      !userKey ||
      !gatewayApiKey
    ) {
      return { ok: false, errors, sources: sourcePaths };
    }

    const config: LoadedConfig = {
      enabled: true,
      endpoint,
      serviceId,
      teamId: required.teamId,
      agentId: required.agentId,
      userId: required.userId,
      userKey,
      gatewayApiKey,
      timeoutMs,
      rejectUnauthorized: values.rejectUnauthorized ?? true,
      captureTools: values.captureTools ?? false,
      recall,
      skills,
      sources: sourcePaths,
      userKeySource,
      gatewayApiKeySource,
    };
    return { ok: true, config };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      sources: sources.map((source) => source.path),
    };
  }
}
