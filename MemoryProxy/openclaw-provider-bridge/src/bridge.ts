import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { assertSafeHeaderValue } from "./config.js";
import { IdentityRegistry } from "./registry.js";

type StreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
function requireRuntimeId(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`[memory-proxy] OpenClaw did not provide ${label}; refusing to use a global identity fallback`);
  return assertSafeHeaderValue(normalized, label);
}

/** Attach a frozen Agent/Session identity snapshot on every transport call. */
export function wrapMemoryProxyStream(context: ProviderWrapStreamFnContext, registry: IdentityRegistry): StreamFn | undefined {
  const base = context.streamFn;
  if (!base) return undefined;
  const openClawAgentId = requireRuntimeId(context.agentId, "agentId");
  return async (model, messages, options = {}) => {
    const openClawSessionId = requireRuntimeId(options.sessionId, "sessionId");
    const identity = await registry.getOrCreateSession(openClawAgentId, openClawSessionId);
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
      "x-conversation-id": assertSafeHeaderValue(identity.conversationId, "conversationId"),
      "x-team-id": assertSafeHeaderValue(identity.teamId, "teamId"),
      "x-agent-id": assertSafeHeaderValue(identity.memoryAgentId, "memoryAgentId"),
      "x-openclaw-agent-id": openClawAgentId,
      "x-openclaw-session-id": openClawSessionId,
    };
    if (identity.taskId) headers["x-task-id"] = assertSafeHeaderValue(identity.taskId, "taskId");
    else delete headers["x-task-id"];
    return base(model, messages, { ...options, headers });
  };
}
