/**
 * Code-Graph Routes — 13 endpoints (Hono rewrite).
 *
 * Management (5): create / list / get / sync / delete
 * Query (8): search / explore / callers / callees / impact / node / status / files
 *
 * Query endpoints delegate to engines/code executeTool, return {text, isError}.
 * Routes are defined WITHOUT /v2 prefix — prefix applied at server.ts mount level.
 *
 * 多租户（001）：`service_id` 每个端点必传于 `x-tdai-service-id` 请求头（与内核路由键统一）。
 * id-only 端点用 `getById(service_id, code_graph_id)` 收敛归属，跨租户返回 404（R1）；
 * service_id / code_graph_id 先做路径分段白名单校验（R5）。
 */

import { Hono } from "hono";
import { buildCodeGraphToolParams } from "../engines/code/tool-params.js";

import type { CodeGraphService } from "../store/index.js";
import type { SyncStatus } from "../store/index.js";
import { executeTool as executeCodeTool } from "../engines/code/index.js";
import { toCodeGraphToolName, CODEGRAPH_QUERY_TOOL_NAMES } from "./tools.js";
import {
  extractIdFields,
  isValidIdSegment,
  wrapOk,
  wrapError,
  toCodeGraphDetail,
  type BatchDeleteResult,
} from "../api-helpers.js";
import type { CodeGraphInstancePool } from "../module.js";

export interface CodeGraphRouteDeps {
  cgService: CodeGraphService;
  instancePool: CodeGraphInstancePool;
  /** Public base URL for service_url; should already include the API prefix (e.g. http://host:8421/v3). */
  publicBaseUrl: string;
}

// ───────────────────────── Query Specs ─────────────────────────

export function createCodeGraphRoutes(deps: CodeGraphRouteDeps): Hono {
  const app = new Hono();
  const { cgService, instancePool, publicBaseUrl } = deps;

  // ═══════════════════ Management ═══════════════════

  app.post("/create", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const repoUrl = body.repo_url;
    if (typeof repoUrl !== "string" || !repoUrl) return c.json(wrapError(400, "repo_url is required"), 400);

    const branch = typeof body.branch === "string" && body.branch ? body.branch : "main";
    const repoName = typeof body.repo_name === "string" ? body.repo_name : undefined;

    // 私有仓：可选 provider_id + secret，与 create 同请求传入，入队前落凭据（消除时序窗口）。
    const providerId = typeof body.provider_id === "string" ? body.provider_id : undefined;
    const secret = typeof body.secret === "string" ? body.secret : undefined;
    const username = typeof body.username === "string" ? body.username : undefined;
    if (providerId && !secret) return c.json(wrapError(400, "secret is required when provider_id is set"), 400);

    const { row, existed } = cgService.create({
      service_id: idFields.service_id,
      team_id: idFields.team_id,
      repo_url: repoUrl,
      branch,
      repo_name: repoName,
      owner_user_id: idFields.user_id,
      user_id: idFields.user_id,
      agent_id: idFields.agent_id,
      task_id: idFields.task_id,
      credential: providerId && secret ? { provider_id: providerId, secret, username } : undefined,
    });

    // Persist service_url (tools self-discovery base; resource selected via
    // knowledge_id in request body, so the URL is service-level, not
    // resource-scoped). publicBaseUrl already includes the API prefix; proxy
    // appends `/tools/list` | `/tools/call` directly.
    if (!existed && publicBaseUrl) {
      const serviceUrl = publicBaseUrl;
      const updated = cgService.updateServiceUrl(idFields.service_id, row.code_graph_id, serviceUrl);
      if (updated) return c.json(wrapOk(toCodeGraphDetail(updated)), 201);
    }

    return c.json(wrapOk(toCodeGraphDetail(row)), existed ? 200 : 201);
  });

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const idFields = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!idFields) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const status = typeof body.status === "string" ? (body.status as SyncStatus) : undefined;
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const offset = typeof body.offset === "number" ? body.offset : 0;

    const items = cgService.list(idFields.service_id, idFields.team_id, { syncStatus: status, limit, offset });
    const total = cgService.count(idFields.service_id, idFields.team_id, status ? { syncStatus: status } : undefined);
    return c.json(wrapOk({ items: items.map(toCodeGraphDetail), total }));
  });

  app.post("/get", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);
    return c.json(wrapOk(toCodeGraphDetail(row)));
  });

  app.post("/update-meta", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

    const patch: { repo_name?: string; summary?: string | null } = {};
    if (typeof body.repo_name === "string" && body.repo_name) patch.repo_name = body.repo_name;
    if (body.summary !== undefined) {
      patch.summary = typeof body.summary === "string" ? body.summary : null;
    }
    if (!patch.repo_name && patch.summary === undefined) {
      return c.json(wrapError(400, "at least one of repo_name/summary must be provided"), 400);
    }

    const updated = cgService.updateMeta(serviceId, cgId, patch);
    if (!updated) return c.json(wrapError(404, "code graph not found"), 404);
    return c.json(wrapOk(toCodeGraphDetail(updated)));
  });

  app.post("/sync", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgId = body.code_graph_id;
    if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);
    const requesterUserId = typeof body.user_id === "string" && body.user_id ? body.user_id : undefined;

    const row = cgService.getById(serviceId, cgId);
    if (!row) return c.json(wrapError(404, "code graph not found"), 404);

    const result = cgService.sync(serviceId, row.team_id, cgId, requesterUserId);
    if (result.kind === "not_found") return c.json(wrapError(404, "code graph not found"), 404);
    if (result.kind === "busy") {
      // 并发拒绝：干净最小的 409 响应体（调用方用 code 判断，不 parse message）。
      return c.json({ code: 409, message: "busy", data: { status: result.status, step: result.step } }, 409);
    }
    return c.json(wrapOk({ code_graph_id: result.row.code_graph_id, status: result.row.status }), 202);
  });

  app.post("/delete", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const cgIds = body.code_graph_ids;
    if (!Array.isArray(cgIds) || cgIds.length === 0) {
      return c.json(wrapError(400, "code_graph_ids is required (non-empty array)"), 400);
    }
    if (cgIds.length > 100) {
      return c.json(wrapError(400, "code_graph_ids exceeds max 100"), 400);
    }

    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of cgIds) {
      if (!isValidIdSegment(id)) {
        result.failed.push({ id: String(id), reason: "invalid id" });
        continue;
      }
      const row = cgService.getById(serviceId, id);
      if (!row) {
        result.failed.push({ id, reason: "not found" });
        continue;
      }
      const ok = cgService.delete(serviceId, row.team_id, id);
      if (ok) {
        // instance pool 释放已由 service.cleanupResources(releaseInstance) 统一处理。
        result.deleted_ids.push(id);
      } else {
        result.failed.push({ id, reason: "delete failed" });
      }
    }
    return c.json(wrapOk(result));
  });

  // ═══════════════════ Query (8 codegraph tools, all id-only) ═══════════════════

  // Register all query endpoints from the shared tool name list
  for (const action of CODEGRAPH_QUERY_TOOL_NAMES) {
    app.post(`/${action}`, async (c) => {
      const body = await c.req.json<Record<string, unknown>>();

      const serviceId = c.req.header("x-tdai-service-id");
      if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
      const cgId = body.code_graph_id;
      if (!isValidIdSegment(cgId)) return c.json(wrapError(400, "code_graph_id is required"), 400);

      const row = cgService.getById(serviceId, cgId);
      if (!row) return c.json(wrapError(404, "code graph not found"), 404);

      const built = buildCodeGraphToolParams(action, body, true);
      if ("error" in built) {
        return c.json(wrapError(400, built.error), 400);
      }

      if (row.status !== "ready") {
        return c.json(wrapOk({ text: "", isError: false }));
      }

      let instance = instancePool.get(cgId);
      if (!instance && instancePool.loadIfMissing) {
        const dir = cgService.dirFor(serviceId, row.team_id, cgId);
        instance = await instancePool.loadIfMissing(cgId, dir);
      }
      if (!instance) {
        return c.json(wrapError(503, "code graph instance not loaded"), 503);
      }

      const toolName = toCodeGraphToolName(action);
      if (!toolName) {
        return c.json(wrapError(403, `unknown tool: ${action}`), 403);
      }
      const result = await executeCodeTool(instance, toolName, built.params);
      return c.json(wrapOk(result), result.isError ? 500 : 200);
    });
  }

  return app;
}
