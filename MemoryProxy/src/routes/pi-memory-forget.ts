import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { extractBearerToken } from "../opik.js";
import { getSessionStore } from "../session/store.js";
import { resolveConversationId } from "../session/session-key.js";
import { getCoreSkillClient } from "../skill/core-client.js";
import type { ProxyConfig } from "../types.js";
import { ForgetPendingStore } from "../memory/forget-pending-store.js";
import { renderForgetPreview } from "../memory/forget-redaction.js";
import { ForgetService, type ForgetIdentity } from "../memory/forget-service.js";

interface ResolvedForgetSession {
  sessionKey: string;
  identity: ForgetIdentity;
}

interface ForgetRouteService {
  discover(identity: ForgetIdentity, keyword: string): ReturnType<ForgetService["discover"]>;
  execute(identity: ForgetIdentity, target: Parameters<ForgetService["execute"]>[1]): ReturnType<ForgetService["execute"]>;
}

interface ForgetRouteDeps {
  service?: ForgetRouteService;
  pending?: ForgetPendingStore;
  resolveSession?: (c: Context) => ResolvedForgetSession | null;
  now?: () => number;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultSessionResolver(config: ProxyConfig): (c: Context) => ResolvedForgetSession | null {
  return (c) => {
    const conversationId = resolveConversationId(c);
    if (!conversationId) return null;

    const state = getSessionStore().get(`pi:${conversationId}`);
    const info = state?.status === "initialized" ? state.sessionInfo : undefined;
    if (!info?.user_id || !info.team_id || !info.agent_id || !info.user_key) return null;

    const bearer = extractBearerToken(c.req.header("authorization"));
    if (!bearer || !constantTimeEqual(bearer, info.user_key)) return null;

    const requestedServiceId = c.req.header("x-tdai-service-id") ?? "";
    const serviceId = info.space_id || requestedServiceId || config.coreSkill.serviceId;
    if (!serviceId || (info.space_id && requestedServiceId && info.space_id !== requestedServiceId)) return null;

    return {
      sessionKey: `pi:${conversationId}`,
      identity: {
        userId: info.user_id,
        teamId: info.team_id,
        agentId: info.agent_id,
        serviceId,
      },
    };
  };
}

function publicCandidate(
  candidate: Awaited<ReturnType<ForgetRouteService["discover"]>>[number],
  actionId: string,
) {
  return {
    actionId,
    kind: candidate.kind,
    name: renderForgetPreview(candidate.name),
    preview: candidate.preview,
    detail: candidate.detail,
    impact: candidate.impact,
  };
}

function ok(c: Context, data: unknown) {
  return c.json({ code: 0, data });
}

function fail(c: Context, status: 400 | 401 | 404 | 409 | 500 | 503, message: string) {
  return c.json({ code: status, message }, status);
}

export function createPiMemoryForgetHandlers(config: ProxyConfig, deps: ForgetRouteDeps = {}) {
  const now = deps.now ?? Date.now;
  const service = deps.service ?? new ForgetService(getCoreSkillClient(config.coreSkill));
  const pending = deps.pending ?? new ForgetPendingStore({ now });
  const resolveSession = deps.resolveSession ?? defaultSessionResolver(config);

  return {
    preview: async (c: Context) => {
      const session = resolveSession(c);
      if (!session) return fail(c, 401, "initialized Pi session and matching user key required");

      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
        return fail(c, 400, "JSON body required");
      }
      const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
      if (!keyword || keyword.length > 256) return fail(c, 400, "keyword must be 1-256 characters");

      try {
        const candidates = await service.discover(session.identity, keyword);
        return ok(c, {
          state: "select",
          candidates: candidates.map((candidate) => {
            const actionId = pending.prepare(session.sessionKey, candidate);
            return publicCandidate(candidate, actionId);
          }),
        });
      } catch {
        return fail(c, 503, "memory forget preview is temporarily unavailable");
      }
    },

    confirm: async (c: Context) => {
      const session = resolveSession(c);
      if (!session) return fail(c, 401, "initialized Pi session and matching user key required");
      let body: Record<string, unknown>;
      try {
        body = await c.req.json<Record<string, unknown>>();
      } catch {
        return fail(c, 400, "JSON body required");
      }
      const actionId = typeof body.action_id === "string" ? body.action_id : "";
      if (!actionId) return fail(c, 400, "action_id is required");

      try {
        await pending.confirm(actionId, session.sessionKey, (target) =>
          service.execute(session.identity, target));
        return ok(c, {});
      } catch (error) {
        const message = error instanceof Error ? error.message : "memory deletion failed";
        const status = message.includes("missing or expired") ? 404 : 503;
        return fail(c, status, message);
      }
    },
  };
}
