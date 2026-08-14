export interface PiMemoryConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  timeoutMs: number;
  recallLimit: number;
  scenarioLimit: number;
  maxContextChars: number;
  maxCaptureChars: number;
  maxSkillBytes: number;
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
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(key + " must be an integer between " + min + " and " + max);
    return fallback;
  }
  return parsed;
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

export function loadConfig(env: Environment = process.env): ConfigResult {
  const errors: string[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!env[key]?.trim()) errors.push("Missing " + key);
  }

  const endpointRaw = env.TDAI_MEMORY_ENDPOINT?.trim() || "http://127.0.0.1:8420";
  const allowInsecureHttp = readBoolean(env.TDAI_PI_ALLOW_INSECURE_HTTP, false);
  let endpoint = endpointRaw.replace(/\/+$/, "");
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("TDAI_MEMORY_ENDPOINT must use http or https");
    } else if (parsed.protocol === "http:" && !isLoopback(parsed.hostname) && !allowInsecureHttp) {
      errors.push(
        "Remote HTTP would expose the bearer token; use HTTPS or set TDAI_PI_ALLOW_INSECURE_HTTP=1",
      );
    }
    endpoint = parsed.toString().replace(/\/+$/, "");
  } catch {
    errors.push("TDAI_MEMORY_ENDPOINT must be a valid URL");
  }

  const timeoutMs = readInteger(env, "TDAI_PI_TIMEOUT_MS", 5_000, 100, 60_000, errors);
  const recallLimit = readInteger(env, "TDAI_PI_RECALL_LIMIT", 5, 1, 20, errors);
  const scenarioLimit = readInteger(env, "TDAI_PI_SCENARIO_LIMIT", 3, 0, 20, errors);
  const maxContextChars = readInteger(env, "TDAI_PI_MAX_CONTEXT_CHARS", 8_000, 500, 50_000, errors);
  const maxCaptureChars = readInteger(env, "TDAI_PI_MAX_CAPTURE_CHARS", 8_000, 500, 50_000, errors);
  const maxSkillBytes = readInteger(env, "TDAI_PI_MAX_SKILL_BYTES", 512_000, 1_024, 2_000_000, errors);

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
      recallLimit,
      scenarioLimit,
      maxContextChars,
      maxCaptureChars,
      maxSkillBytes,
      includeCore: readBoolean(env.TDAI_PI_INCLUDE_CORE, true),
      includeScenarios: readBoolean(env.TDAI_PI_INCLUDE_SCENARIOS, true),
      allowInsecureHttp,
    },
  };
}
