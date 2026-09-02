import { homedir } from "node:os";
import path from "node:path";

export interface CursorConfig {
  rootDir: string;
  gatewayUrl?: string;
  gatewayApiKey?: string;
  serviceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  taskId?: string;
  captureTimeoutMs: number;
  recallTimeoutMs: number;
  executablePath: string;
  transcriptsRoot: string;
}

type Env = Record<string, string | undefined>;

function positiveInt(
  value: string | undefined,
  fallback: number,
  maximum?: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

export function resolveCursorConfig(
  env: Env = process.env,
  home = env.HOME ?? env.USERPROFILE ?? homedir(),
  executablePath = process.argv[1] ?? "memory-tencentdb-cursor",
): CursorConfig {
  return {
    rootDir:
      env.MEMORY_TENCENTDB_CURSOR_ROOT ??
      path.join(home, ".memory-tencentdb", "cursor"),
    gatewayUrl:
      env.MEMORY_TENCENTDB_GATEWAY_URL ?? env.TDAI_MEMORY_ENDPOINT,
    gatewayApiKey:
      env.MEMORY_TENCENTDB_GATEWAY_API_KEY ??
      env.TDAI_MEMORY_API_KEY ??
      env.TDAI_GATEWAY_API_KEY,
    serviceId:
      env.MEMORY_TENCENTDB_SERVICE_ID ?? env.TDAI_MEMORY_INSTANCE_ID,
    teamId: env.MEMORY_TENCENTDB_TEAM_ID ?? env.TDAI_MEMORY_TEAM_ID,
    agentId: env.MEMORY_TENCENTDB_AGENT_ID ?? env.TDAI_MEMORY_AGENT_ID,
    userId: env.MEMORY_TENCENTDB_USER_ID ?? env.TDAI_MEMORY_USER_ID,
    taskId: env.MEMORY_TENCENTDB_TASK_ID ?? env.TDAI_MEMORY_TASK_ID,
    captureTimeoutMs: positiveInt(
      env.MEMORY_TENCENTDB_CURSOR_CAPTURE_TIMEOUT_MS,
      60_000,
    ),
    recallTimeoutMs: positiveInt(
      env.MEMORY_TENCENTDB_CURSOR_RECALL_TIMEOUT_MS,
      2_000,
      2_000,
    ),
    executablePath,
    transcriptsRoot:
      env.MEMORY_TENCENTDB_CURSOR_TRANSCRIPTS_ROOT ??
      path.join(home, ".cursor", "projects"),
  };
}
