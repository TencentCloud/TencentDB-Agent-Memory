import { createHash } from "node:crypto";
import { GatewayConfigurationError } from "./errors.js";

export interface TdaiIdentity {
  serviceId: string;
  instanceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  sessionId: string;
  sessionKey: string;
}

export interface ResolveTdaiIdentityOptions {
  env?: Record<string, string | undefined>;
  sessionId?: string;
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new GatewayConfigurationError(
      `Missing TencentDB Agent Memory identity: ${name}`,
    );
  }
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function deriveTdaiSessionKey(
  identity: Omit<TdaiIdentity, "sessionKey">,
): string {
  const canonical = JSON.stringify([
    identity.serviceId,
    identity.instanceId,
    identity.teamId,
    identity.agentId,
    identity.userId,
    identity.taskId ?? null,
    identity.sessionId,
  ]);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `codex:${digest}`;
}

/**
 * Validate an identity supplied by an embedding caller such as the MCP
 * server. TypeScript types do not protect runtime/plugin boundaries, so the
 * derived session key is checked instead of trusting caller-controlled state.
 */
export function assertTdaiIdentity(identity: unknown): TdaiIdentity {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new GatewayConfigurationError(
      "Invalid TencentDB Agent Memory identity: expected an object",
    );
  }
  const candidate = identity as Partial<Record<keyof TdaiIdentity, unknown>>;
  const fields = [
    ["serviceId", candidate.serviceId],
    ["instanceId", candidate.instanceId],
    ["teamId", candidate.teamId],
    ["agentId", candidate.agentId],
    ["userId", candidate.userId],
    ["sessionId", candidate.sessionId],
  ] as const;
  for (const [name, value] of fields) {
    if (typeof value !== "string" || !value.trim()) {
      throw new GatewayConfigurationError(
        `Invalid TencentDB Agent Memory identity: ${name} must be a non-empty string`,
      );
    }
  }
  if (candidate.taskId !== undefined
    && (typeof candidate.taskId !== "string" || !candidate.taskId.trim())) {
    throw new GatewayConfigurationError(
      "Invalid TencentDB Agent Memory identity: taskId must be a non-empty string when provided",
    );
  }
  if (typeof candidate.sessionKey !== "string" || !candidate.sessionKey.trim()) {
    throw new GatewayConfigurationError(
      "Invalid TencentDB Agent Memory identity: sessionKey must be a non-empty string",
    );
  }
  const typedIdentity = {
    serviceId: (candidate.serviceId as string).trim(),
    instanceId: (candidate.instanceId as string).trim(),
    teamId: (candidate.teamId as string).trim(),
    agentId: (candidate.agentId as string).trim(),
    userId: (candidate.userId as string).trim(),
    ...(candidate.taskId === undefined ? {} : { taskId: (candidate.taskId as string).trim() }),
    sessionId: (candidate.sessionId as string).trim(),
    sessionKey: (candidate.sessionKey as string).trim(),
  } satisfies TdaiIdentity;
  const expectedSessionKey = deriveTdaiSessionKey(typedIdentity);
  if (typedIdentity.sessionKey !== expectedSessionKey) {
    throw new GatewayConfigurationError(
      "Invalid TencentDB Agent Memory identity: sessionKey does not match the derived identity",
    );
  }
  return typedIdentity;
}

/**
 * Resolve the strict identity shared by Codex hooks and MCP.
 *
 * Team, agent, and user deliberately have no fabricated defaults. The caller
 * decides whether a configuration error is fail-open (hooks) or user-visible
 * (MCP).
 */
export function resolveTdaiIdentity(
  options: ResolveTdaiIdentityOptions = {},
): TdaiIdentity {
  const env = options.env ?? process.env;
  const base = {
    serviceId: required(env.TDAI_SERVICE_ID, "TDAI_SERVICE_ID"),
    instanceId: required(env.TDAI_INSTANCE_ID, "TDAI_INSTANCE_ID"),
    teamId: required(env.TDAI_TEAM_ID, "TDAI_TEAM_ID"),
    agentId: required(env.TDAI_AGENT_ID, "TDAI_AGENT_ID"),
    userId: required(env.TDAI_USER_ID, "TDAI_USER_ID"),
    taskId: optional(env.TDAI_TASK_ID),
    sessionId: required(options.sessionId ?? env.TDAI_SESSION_ID, "session_id"),
  };
  return assertTdaiIdentity({
    ...base,
    sessionKey: deriveTdaiSessionKey(base),
  });
}
