/**
 * Configuration loading and validation for the Pi memory adapter.
 *
 * All settings come from environment variables so the adapter never persists
 * credentials. Required variables are validated up front; numeric values are
 * clamped to sane ranges; and remote plain-HTTP endpoints are rejected by
 * default to avoid leaking the bearer token.
 */

export interface PiMemoryConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  timeoutMs: number;
  recallBudgetMs: number;
  recallLimit: number;
  scenarioLimit: number;
  maxContextChars: number;
  maxCaptureChars: number;
  includeCore: boolean;
  includeScenarios: boolean;
  allowInsecureHttp: boolean;
}

export type ConfigResult =
  | { ok: true; value: PiMemoryConfig }
  | { ok: false; errors: string[] };

type Environment = Record<string, string | undefined>;

const REQUIRED_KEYS = [
  "TDAI_MEMORY_API_KEY",
  "TDAI_MEMORY_SERVICE_ID",
  "TDAI_MEMORY_TEAM_ID",
  "TDAI_MEMORY_AGENT_ID",
  "TDAI_MEMORY_USER_ID",
] as const;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readInteger(
  env: Environment,
  key: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    errors.push(`${key} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  const parsed = Number(raw);
  if (parsed < min || parsed > max) {
    errors.push(`${key} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return parsed;
}

/**
 * Validate an endpoint and return its normalized (trailing-slash-free) form.
 * Rejects remote plain HTTP unless explicitly allowed.
 */
function normalizeEndpoint(raw: string, allowInsecureHttp: boolean, errors: string[]): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("TDAI_MEMORY_ENDPOINT must use http or https");
      return raw;
    }
    if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) && !allowInsecureHttp) {
      errors.push(
        "Remote HTTP would expose the bearer token; use HTTPS or set TDAI_PI_ALLOW_INSECURE_HTTP=1",
      );
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    errors.push("TDAI_MEMORY_ENDPOINT must be a valid URL");
    return raw;
  }
}

export function loadConfig(env: Environment = process.env): ConfigResult {
  const errors: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!env[key]?.trim()) errors.push(`Missing ${key}`);
  }

  const endpointRaw = env.TDAI_MEMORY_ENDPOINT?.trim() || "http://127.0.0.1:8420";
  const allowInsecureHttp = readBoolean(env.TDAI_PI_ALLOW_INSECURE_HTTP, false);
  const endpoint = normalizeEndpoint(endpointRaw, allowInsecureHttp, errors);

  const timeoutMs = readInteger(env, "TDAI_PI_TIMEOUT_MS", 5_000, 100, 60_000, errors);
  const recallBudgetMs = readInteger(env, "TDAI_PI_RECALL_BUDGET_MS", 1_500, 100, 60_000, errors);
  const recallLimit = readInteger(env, "TDAI_PI_RECALL_LIMIT", 5, 1, 20, errors);
  const scenarioLimit = readInteger(env, "TDAI_PI_SCENARIO_LIMIT", 3, 0, 20, errors);
  const maxContextChars = readInteger(env, "TDAI_PI_MAX_CONTEXT_CHARS", 8_000, 500, 50_000, errors);
  const maxCaptureChars = readInteger(env, "TDAI_PI_MAX_CAPTURE_CHARS", 12_000, 500, 100_000, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      endpoint,
      apiKey: env.TDAI_MEMORY_API_KEY!.trim(),
      serviceId: env.TDAI_MEMORY_SERVICE_ID!.trim(),
      teamId: env.TDAI_MEMORY_TEAM_ID!.trim(),
      agentId: env.TDAI_MEMORY_AGENT_ID!.trim(),
      userId: env.TDAI_MEMORY_USER_ID!.trim(),
      taskId: env.TDAI_MEMORY_TASK_ID?.trim() || undefined,
      timeoutMs,
      recallBudgetMs,
      recallLimit,
      scenarioLimit,
      maxContextChars,
      maxCaptureChars,
      includeCore: readBoolean(env.TDAI_PI_INCLUDE_CORE, true),
      includeScenarios: readBoolean(env.TDAI_PI_INCLUDE_SCENARIOS, true),
      allowInsecureHttp,
    },
  };
}
