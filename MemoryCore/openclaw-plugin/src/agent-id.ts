/**
 * Resolve the v3 isolation agent id for one OpenClaw request.
 *
 * Order: `agent:<id>:<rest>` on the session key, then non-empty `ctx.agentId`,
 * then configured `server.agentId`, then `"default"`. OpenClaw does not
 * support per-agent plugin config, so a single static `server.agentId`
 * cannot isolate multiple agents.
 */

export function extractAgentId(sessionKey: unknown): string | undefined {
  if (typeof sessionKey !== "string") return undefined;
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") return undefined;
  const id = parts[1].trim();
  return id.length > 0 ? id : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveRequestAgentId(
  ctx: { sessionKey?: unknown; agentId?: unknown } | null | undefined,
  configuredAgentId: string | undefined,
): string {
  return extractAgentId(ctx?.sessionKey)
    ?? nonEmpty(ctx?.agentId)
    ?? nonEmpty(configuredAgentId)
    ?? "default";
}
