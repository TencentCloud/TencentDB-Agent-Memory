/**
 * source-credential routes —— 外部知识源的令牌 CRUD（**按资源 id**）。
 *
 * 安全边界：
 *   - 只进不出：PUT 接受明文令牌，任何响应都**不回吐** secret（GET 只给元数据）。
 *   - 按资源隔离：主键 (service_id, resource_type, resource_id)，越权 → 404。
 *   - 越权门控：PUT/DELETE 前必须确认该 resource_id 属于请求头 team_id，
 *     否则 A 团队可给 B 团队的资源写凭据。
 *   - 身份来自请求头（x-tdai-service-id / x-tdai-team-id / x-tdai-user-id），
 *     绝不收 body 里的 user_id / team_id。
 *
 * 说明：本路由只做凭据存取，**不做**任何拉取 / 建图动作。
 */

import { Hono } from "hono";
import { CodeGraphAuthError, type CodeGraphAuthService } from "../source-auth/code-graph-auth.js";
import { GitCredentialError } from "../store/git-credential-store.js";
import { verifyBearer } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import type { IKnowledgeStore } from "../store/types.js";
import type {
  CredentialKind,
  ICredentialStore,
  ResourceRef,
  ResourceType,
} from "../source-auth/types.js";

const VALID_KINDS: CredentialKind[] = ["bearer", "basic"];
const VALID_TYPES: ResourceType[] = ["code-graph", "wiki"];

export interface SourceCredentialRouteDeps {
  credentialStore: ICredentialStore;
  codeGraphAuth: CodeGraphAuthService;
  serviceKey: string;
  /** 用于校验 resource_id 属于请求头 team_id（越权门控）。 */
  store: IKnowledgeStore;
}

interface Actor {
  serviceId: string;
  teamId: string;
  userId: string;
}

function actor(c: { req: { header(name: string): string | undefined } }): Actor | null {
  const serviceId = c.req.header("x-tdai-service-id");
  const teamId = c.req.header("x-tdai-team-id");
  const userId = c.req.header("x-tdai-user-id");
  if (!isValidIdSegment(serviceId) || !isValidIdSegment(teamId) || !isValidIdSegment(userId)) {
    return null;
  }
  return { serviceId: serviceId as string, teamId: teamId as string, userId: userId as string };
}

/** 解析并校验 resource_type + resource_id；成功后返回 ResourceRef。 */
function parseRef(
  serviceId: string,
  rawType: unknown,
  rawId: unknown,
): ResourceRef | { error: string } {
  if (typeof rawType !== "string" || !(VALID_TYPES as string[]).includes(rawType)) {
    return { error: `resource_type must be one of ${VALID_TYPES.join(", ")}` };
  }
  if (typeof rawId !== "string" || !isValidIdSegment(rawId)) {
    return { error: "resource_id is required and must be a valid id" };
  }
  return { type: rawType as ResourceType, serviceId, resourceId: rawId };
}

/**
 * 团队门控：确认 resource_id 属于 actor.teamId。
 * 不存在或 team 不匹配 → 404（不区分，避免探测存在性）。
 */
function ensureTeamOwnership(
  store: IKnowledgeStore,
  actor: Actor,
  ref: ResourceRef,
): { ok: true } | { ok: false; status: 404 } {
  const row =
    ref.type === "code-graph"
      ? store.getCodeGraphById(actor.serviceId, ref.resourceId)
      : store.getWikiById(actor.serviceId, ref.resourceId);
  if (!row || row.team_id !== actor.teamId) {
    return { ok: false, status: 404 };
  }
  return { ok: true };
}

export function createSourceCredentialRoutes(deps: SourceCredentialRouteDeps): Hono {
  const app = new Hono();
  const { credentialStore, store } = deps;
  app.onError((error, c) => {
    if (error instanceof CodeGraphAuthError || error instanceof GitCredentialError) {
      return c.json(wrapError(error.status, error.message), error.status);
    }
    return errorHandler(error, c);
  });
  const serviceAuthenticated = (authorization: string | undefined) =>
    !!deps.serviceKey && verifyBearer(authorization, deps.serviceKey);

  // GET /status?resource_type=xxx&resource_id=yyy —— 元数据（不含 secret）
  app.get("/status", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const refOrErr = parseRef(who.serviceId, c.req.query("resource_type"), c.req.query("resource_id"));
    if ("error" in refOrErr) return c.json(wrapError(400, refOrErr.error), 400);

    const gate = ensureTeamOwnership(store, who, refOrErr);
    if (!gate.ok) return c.json(wrapError(404, "resource not found"), 404);

    const status = refOrErr.type === "code-graph"
      ? deps.codeGraphAuth.resourceStatus(who.serviceId, refOrErr.resourceId, {
          ...who, serviceAuthenticated: serviceAuthenticated(c.req.header("authorization")),
        })
      : credentialStore.status(refOrErr);
    return c.json(wrapOk({ configured: !!status, credential: status }));
  });

  // DELETE /delete?resource_type=xxx&resource_id=yyy —— 删除令牌
  app.delete("/delete", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const refOrErr = parseRef(who.serviceId, c.req.query("resource_type"), c.req.query("resource_id"));
    if ("error" in refOrErr) return c.json(wrapError(400, refOrErr.error), 400);

    const gate = ensureTeamOwnership(store, who, refOrErr);
    if (!gate.ok) return c.json(wrapError(404, "resource not found"), 404);

    if (refOrErr.type === "code-graph") {
      return c.json(wrapOk(deps.codeGraphAuth.deleteResource(who.serviceId, refOrErr.resourceId, {
        ...who, serviceAuthenticated: serviceAuthenticated(c.req.header("authorization")),
      })));
    }
    const ok = credentialStore.delete(refOrErr);
    if (!ok) return c.json(wrapError(404, "credential not found"), 404);
    return c.json(wrapOk({ deleted: true }));
  });

  // PUT /put —— 写入 / 更新令牌。
  // body: { resource_type, resource_id, provider_id, cred_kind, secret, username?, extra? }
  app.put("/put", async (c) => {
    const who = actor(c);
    if (!who) {
      return c.json(wrapError(400, "x-tdai-service-id/team-id/user-id headers are required"), 400);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const refOrErr = parseRef(who.serviceId, body.resource_type, body.resource_id);
    if ("error" in refOrErr) return c.json(wrapError(400, refOrErr.error), 400);

    const providerId = body.provider_id;
    if (typeof providerId !== "string" || !providerId) {
      return c.json(wrapError(400, "provider_id is required"), 400);
    }
    const secret = body.secret;
    if (typeof secret !== "string" || !secret) {
      return c.json(wrapError(400, "secret is required"), 400);
    }
    const kind = (typeof body.cred_kind === "string" ? body.cred_kind : "bearer") as CredentialKind;
    if (!VALID_KINDS.includes(kind) || (refOrErr.type === "code-graph" && body.cred_kind !== undefined && typeof body.cred_kind !== "string")) {
      return c.json(wrapError(400, `cred_kind must be one of ${VALID_KINDS.join(", ")}`), 400);
    }
    if (kind === "basic" && typeof body.username !== "string") {
      return c.json(wrapError(400, "username is required for basic credential"), 400);
    }
    const extra = typeof body.extra === "object" && body.extra !== null
      ? (body.extra as Record<string, unknown>) : undefined;

    const gate = ensureTeamOwnership(store, who, refOrErr);
    if (!gate.ok) return c.json(wrapError(404, "resource not found"), 404);

    if (refOrErr.type === "code-graph") {
      const authActor = { ...who, serviceAuthenticated: serviceAuthenticated(c.req.header("authorization")) };
      deps.codeGraphAuth.replace(who.serviceId, refOrErr.resourceId, {
        mode: "resource", provider_id: providerId, secret, cred_kind: kind, extra,
        username: typeof body.username === "string" ? body.username : undefined,
      }, authActor);
      return c.json(wrapOk({ credential: deps.codeGraphAuth.resourceStatus(who.serviceId, refOrErr.resourceId, authActor) }));
    }

    credentialStore.put(
      refOrErr,
      {
        kind,
        secret,
        username: typeof body.username === "string" ? body.username : undefined,
        extra,
      },
      providerId,
      who.userId,
    );

    // 只回元数据，永不回吐 secret。
    const status = credentialStore.status(refOrErr);
    return c.json(wrapOk({ credential: status }));
  });

  return app;
}
