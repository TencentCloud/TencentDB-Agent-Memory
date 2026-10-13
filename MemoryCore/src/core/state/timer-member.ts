import type { TaskPayload } from "./types.js";

export interface PipelineTimerMemberContext {
  teamId?: string;
  agentId?: string;
}

export interface ParsedPipelineTimerMember extends PipelineTimerMemberContext {
  sessionId: string;
  timerType: string;
  taskType: TaskPayload["type"];
  priority: number;
}

const SCOPED_TIMER_PREFIX = "scope:";

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function classifyTimerType(timerType: string): Pick<ParsedPipelineTimerMember, "taskType" | "priority"> {
  if (timerType.startsWith("L1")) return { taskType: "L1", priority: 0 };
  if (timerType.startsWith("L2")) return { taskType: "L2", priority: 1 };
  if (timerType.startsWith("L3")) return { taskType: "L3", priority: 2 };
  return { taskType: "flush", priority: 0 };
}

export function buildPipelineTimerMember(
  sessionId: string,
  timerType: string,
  ctx?: PipelineTimerMemberContext,
): string {
  // Timer names are internal scheduling labels, not identity components.
  if (!/^[A-Za-z0-9_-]+$/.test(timerType)) throw new Error("Invalid pipeline timer type");
  const tenant = ctx?.teamId !== undefined || ctx?.agentId !== undefined
    ? ctx : parseProfileSessionTenant(sessionId);
  const fields: string[] = [];
  if (tenant?.teamId !== undefined) fields.push(`team:${encodeURIComponent(tenant.teamId)}`);
  if (tenant?.agentId !== undefined) fields.push(`agent:${encodeURIComponent(tenant.agentId)}`);
  fields.push(`session:${encodeURIComponent(sessionId)}`);
  // Always wrap the session, even without a tenant. A literal session that
  // resembles scoped syntax must not be interpreted as another identity.
  return `${SCOPED_TIMER_PREFIX}${fields.join("|")}:${timerType}`;
}

export function parseProfileSessionTenant(sessionId: string): PipelineTimerMemberContext | undefined {
  const m = sessionId.match(/^profile:team:([^|]+)\|agent:([^|]+)(?:\|session:.+)?$/);
  if (!m) return undefined;
  return { teamId: m[1], agentId: m[2] };
}

export function parsePipelineTimerMember(member: string): ParsedPipelineTimerMember {
  if (member.startsWith(SCOPED_TIMER_PREFIX)) {
    const lastColon = member.lastIndexOf(":");
    if (lastColon > SCOPED_TIMER_PREFIX.length) {
      const timerType = member.slice(lastColon + 1);
      const scope = member.slice(SCOPED_TIMER_PREFIX.length, lastColon);
      const values: Record<string, string> = Object.create(null);
      for (const part of scope.split("|")) {
        const idx = part.indexOf(":");
        if (idx > 0) values[part.slice(0, idx)] = part.slice(idx + 1);
      }
      const sessionId = values.session !== undefined ? safeDecodeURIComponent(values.session) : "";
      if (values.session !== undefined) {
        const classified = classifyTimerType(timerType);
        return {
          sessionId,
          timerType,
          ...classified,
          ...(values.team !== undefined ? { teamId: safeDecodeURIComponent(values.team) } : {}),
          ...(values.agent !== undefined ? { agentId: safeDecodeURIComponent(values.agent) } : {}),
        };
      }
    }
  }

  const lastColon = member.lastIndexOf(":");
  if (lastColon <= 0) {
    return { sessionId: member, timerType: "L1_idle", taskType: "L1", priority: 0 };
  }

  const sessionId = member.slice(0, lastColon);
  const timerType = member.slice(lastColon + 1);
  const classified = classifyTimerType(timerType);
  const tenant = parseProfileSessionTenant(sessionId);
  return { sessionId, timerType, ...classified, ...tenant };
}
