/**
 * Session-init web-link endpoints.
 *
 * `GET  /v3/session/init-link/:token` — validate the token and return the
 *   caller's team/agent/task candidates (same list the interactive form
 *   renders). No side effects; a GET never consumes the token.
 *
 * `POST /v3/session/init-link/:token` — body `{ agent_id, task_id? }`; the
 *   team is resolved from the agent (same semantics as the interactive
 *   extractor), the binding registers via the shared `completeRegistration`
 *   path, and the token is consumed. One-shot: a second POST fails.
 *
 * CORS: these two endpoints are called from the Memory Hub page (different
 * origin), so they are registered with permissive CORS. The token itself is
 * the capability credential — no cookies are involved, so CSRF is not a
 * concern, and both endpoints reject unknown/expired/consumed tokens.
 */

import { Hono } from "hono";
import type { ProxyConfig } from "../types.js";
import { MetadataClient } from "../meta/client.js";
import { getSessionStore } from "../session/store.js";
import {
  completeRegistration,
  fetchTeamsAndAgents,
} from "../session/codebuddy/init.js";
import type { SessionInitState, TeamOption } from "../session/types.js";
import {
  claimInitLinkToken,
  completeInitLinkToken,
  releaseInitLinkToken,
  validateInitLinkToken,
} from "../session/init-link.js";

type FetchTeamsFn = typeof fetchTeamsAndAgents;

interface SubmitBody {
  agent_id?: unknown;
  task_id?: unknown;
}

export function registerSessionInitLinkRoutes(
  app: Hono,
  config: ProxyConfig,
  opts?: {
    fetchTeams?: FetchTeamsFn;
    /** Injectable so tests can stub getAgent/getTask without real HTTP. */
    createClient?: (userKey: string, spaceId?: string) => MetadataClient;
  },
): void {
  const fetchTeams: FetchTeamsFn = opts?.fetchTeams ?? fetchTeamsAndAgents;
  const createClient: (userKey: string, spaceId?: string) => MetadataClient =
    opts?.createClient ??
    ((userKey, spaceId) =>
      new MetadataClient(config.coreSkill, spaceId || config.coreSkill.serviceId, userKey));

  const loadCandidates = async (userKey: string, userId: string, spaceId?: string) => {
    const client = createClient(userKey, spaceId);
    return fetchTeams(userId, config.sessionInit, client);
  };

  // ── GET: token → candidate teams/agents/tasks ────────────────────────────
  app.get("/v3/session/init-link/:token", async (c) => {
    const v = validateInitLinkToken(c.req.param("token"));
    if (!v.ok) {
      return c.json({ error: "invalid_token", reason: v.reason }, 404);
    }
    try {
      const { teams } = await loadCandidates(
        v.record.userKey,
        v.record.userId,
        v.record.spaceId,
      );
      return c.json({
        purpose: v.record.purpose,
        agent_source: v.record.agentSource,
        session_id: v.record.sessionId,
        expires_at: new Date(v.record.expiresAt).toISOString(),
        teams,
      });
    } catch (err) {
      console.warn(
        `[init-link] candidate load failed for session=${v.record.compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: "candidate_load_failed" }, 502);
    }
  });

  // ── POST: token + choice → register binding (one-shot) ───────────────────
  app.post("/v3/session/init-link/:token", async (c) => {
    const v = validateInitLinkToken(c.req.param("token"));
    if (!v.ok) {
      return c.json({ error: "invalid_token", reason: v.reason }, 404);
    }
    let body: SubmitBody;
    try {
      body = (await c.req.json()) as SubmitBody;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
    const taskId = typeof body.task_id === "string" ? body.task_id.trim() : "";
    if (!agentId) {
      return c.json({ error: "agent_id_required" }, 400);
    }

    let teams: TeamOption[];
    try {
      teams = (await loadCandidates(v.record.userKey, v.record.userId, v.record.spaceId)).teams;
    } catch (err) {
      console.warn(
        `[init-link] candidate load failed for session=${v.record.compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: "candidate_load_failed" }, 502);
    }
    // Ownership check: the chosen agent must belong to one of the caller's teams.
    const selectedTeam = teams.find((t) => t.agents.some((a) => a.agent_id === agentId));
    if (!selectedTeam) {
      return c.json({ error: "agent_not_in_caller_teams" }, 403);
    }
    if (taskId && !selectedTeam.tasks.some((t) => t.task_id === taskId)) {
      return c.json({ error: "task_not_in_team" }, 403);
    }

    const claim = claimInitLinkToken(v.record.token);
    if (!claim.ok) {
      const status = claim.reason === "processing" ? 409 : 404;
      return c.json({ error: "invalid_token", reason: claim.reason }, status);
    }
    const record = claim.record;
    const store = getSessionStore();
    store.bind(record.compositeKey, {
      userId: record.userId,
      agentSource: record.agentSource,
      sessionId: record.sessionId,
      spaceId: record.spaceId,
    });
    const state: SessionInitState = {
      status: "uninitialized",
      keyId: record.compositeKey,
      startedAt: record.createdAt,
      attemptCount: 0,
      userId: record.userId,
    };
    try {
      await completeRegistration(
        { agent_id: agentId, task_id: taskId || undefined },
        state,
        teams,
        record.compositeKey,
        record.sessionId,
        record.userId,
        config.sessionInit,
        store,
        [] as Record<string, unknown>[],
        createClient(record.userKey, record.spaceId),
        record.userKey,
        record.spaceId,
      );
      if (!(await store.hasDurableInitializedBinding(record.compositeKey))) {
        throw new Error("session binding did not persist to both repositories");
      }
    } catch (err) {
      store.delete(record.compositeKey);
      releaseInitLinkToken(record.token, claim.claimId);
      console.warn(
        `[init-link] registration failed for session=${record.compositeKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: "registration_failed" }, 502);
    }

    const completed = completeInitLinkToken(record.token, claim.claimId);
    if (!completed.ok) {
      console.warn(
        `[init-link] claim completion failed for session=${record.compositeKey}: ${completed.reason}`,
      );
      return c.json({ error: "token_completion_failed" }, 409);
    }

    console.log(
      `[init-link] session=${record.compositeKey} registered via web link: agent=${agentId} task=${taskId || "-"} team=${selectedTeam.team_id}`,
    );
    return c.json({
      ok: true,
      team_id: selectedTeam.team_id,
      team_name: selectedTeam.team_name,
      agent_id: agentId,
      task_id: taskId || null,
    });
  });
}
