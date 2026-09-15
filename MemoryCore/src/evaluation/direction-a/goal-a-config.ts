import path from "node:path";

export const GOAL_A_ENV_PATH = path.join(".research", "direction-a", "secrets", ".env.direction-a.local");

export interface GoalAConfig {
  allowPaidCalls: boolean;
  allowFullDataset: boolean;
  baseUrl: string;
  apiKey: string;
  provider: "deepseek";
  memoryExtractionModel: string;
  targetModel: string;
  judgeModel: string;
  embedding: { provider: "none"; model: "none"; wired: false };
  thinking: "provider_default";
  reasoningEffort: "provider_default";
  maxOutputTokens: number;
  requestTimeoutMs: number;
}

const REQUIRED = [
  "DIRECTION_A_ALLOW_PAID_CALLS",
  "DIRECTION_A_ALLOW_FULL_DATASET",
  "DIRECTION_A_API_KEY",
] as const;

function bool(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/** Reads only the already-loaded DIRECTION_A_* namespace; never opens or changes an env file. */
export function readGoalAConfig(env: NodeJS.ProcessEnv = process.env): GoalAConfig {
  for (const key of REQUIRED) {
    if (!env[key]?.trim()) throw new Error(`Missing required Direction A setting: ${key}`);
  }
  const allowPaidCalls = bool(env.DIRECTION_A_ALLOW_PAID_CALLS);
  const allowFullDataset = bool(env.DIRECTION_A_ALLOW_FULL_DATASET);
  if (!allowPaidCalls) throw new Error("DIRECTION_A_ALLOW_PAID_CALLS must be true for live Goal A");
  if (allowFullDataset) throw new Error("Goal A requires DIRECTION_A_ALLOW_FULL_DATASET=false");

  const provider = env.DIRECTION_A_PROVIDER?.trim().toLowerCase() || "deepseek";
  if (provider !== "deepseek") throw new Error(`Goal A requires provider=deepseek; got ${provider}`);
  const memoryExtractionModel = env.DIRECTION_A_MEMORY_EXTRACTION_MODEL?.trim() || "deepseek-v4-flash";
  const targetModel = env.DIRECTION_A_TARGET_AGENT_MODEL?.trim() || "deepseek-v4-flash";
  const judgeModel = env.DIRECTION_A_QA_JUDGE_MODEL?.trim() || "deepseek-v4-flash";
  const baseUrl = (env.DIRECTION_A_API_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "");
  const maxOutputTokens = Number(env.DIRECTION_A_MAX_OUTPUT_TOKENS ?? 4096);
  const requestTimeoutMs = Number(env.DIRECTION_A_REQUEST_TIMEOUT_MS ?? 120_000);
  if (!(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) throw new Error("DIRECTION_A_MAX_OUTPUT_TOKENS must be a positive integer");
  if (!(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0)) throw new Error("DIRECTION_A_REQUEST_TIMEOUT_MS must be positive");
  return {
    allowPaidCalls,
    allowFullDataset,
    baseUrl,
    apiKey: env.DIRECTION_A_API_KEY!.trim(),
    provider: "deepseek",
    memoryExtractionModel,
    targetModel,
    judgeModel,
    embedding: { provider: "none", model: "none", wired: false },
    thinking: "provider_default",
    reasoningEffort: "provider_default",
    maxOutputTokens,
    requestTimeoutMs,
  };
}

export function redactGoalAConfig(config: GoalAConfig): Omit<GoalAConfig, "apiKey"> & { credential: "configured" } {
  const { apiKey: _secret, ...safe } = config;
  return { ...safe, credential: "configured" };
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), value);
}
