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

import type { CodeGraphService } from "../store/index.js";
import type { SyncStatus } from "../store/index.js";
import { executeTool as executeCodeTool } from "../engines/code/index.js";
import { toCodeGraphToolName, CODEGRAPH_QUERY_TOOL_NAMES } from "./tools.js";
import {
  extractIdFields,
  isValidIdSegment,
  parseListPagination,
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

type FieldRule =
  | { kind: "string"; required?: boolean }
  | { kind: "stringEnum"; required?: boolean; values: string[]; passthrough?: boolean; default?: string }
  | { kind: "boolean"; required?: boolean; default?: boolean }
  | { kind: "int"; required?: boolean; min?: number; max?: number; default?: number };

interface QuerySpec {
  fields: Record<string, FieldRule>;
}

const QUERY_SPECS: Record<string, QuerySpec> = {
  search: {
    fields: {
      query: { kind: "string", required: true },
      kind: {
        kind: "stringEnum",
        values: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
        passthrough: true,
      },
      limit: { kind: "int", min: 1, max: 100, default: 10 },
    },
  },
  explore: {
    fields: {
      query: { kind: "string", required: true },
      maxFiles: { kind: "int", min: 1, max: 200, default: 12 },
    },
  },
  callers: {
    fields: {
      symbol: { kind: "string", required: true },
      limit: { kind: "int", min: 1, max: 200, default: 20 },
    },
  },
  callees: {
    fields: {
      symbol: { kind: "string", required: true },
      limit: { kind: "int", min: 1, max: 200, default: 20 },
    },
  },
  impact: {
    fields: {
      symbol: { kind: "string", required: true },
      depth: { kind: "int", min: 1, max: 10, default: 2 },
    },
  },
  node: {
    fields: {
      symbol: { kind: "string", required: true },
      includeCode: { kind: "boolean", default: false },
      file: { kind: "string" },
      line: { kind: "int", min: 1 },
    },
  },
  status: {
    fields: {},
  },
  files: {
    fields: {
      path: { kind: "string" },
      pattern: { kind: "string" },
      format: { kind: "stringEnum", values: ["tree", "flat", "grouped"], default: "tree", passthrough: true } as FieldRule,
      includeMetadata: { kind: "boolean", default: true },
      maxDepth: { kind: "int", min: 1 },
    },
  },
};

/** Validate query params against spec whitelist + defaults. Returns toolParams or error string. */
function buildToolParams(
  action: string,
  body: Record<string, unknown>,
): { params: Record<string, unknown> } | { error: string } {
  const spec = QUERY_SPECS[action];
  if (!spec) return { error: `unknown action: ${action}` };

  // code_graph_id is the resource routing key consumed by the route handler
  // (not a tool param); allow it so it doesn't trip the undeclared-field guard,
  // but it is never copied into toolParams. service_id now arrives via the
  // x-tdai-service-id header, so it never appears in the body.
  const allowed = new Set(["code_graph_id", ...Object.keys(spec.fields)]);

  // Reject undeclared fields
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      return { error: `unexpected field: ${k}` };
    }
  }

  const params: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(spec.fields)) {
    const raw = body[name];
    const present = raw !== undefined && raw !== null;

    if (!present) {
      if (rule.required) return { error: `${name} is required` };
      if ("default" in rule && rule.default !== undefined) {
        const passthrough = rule.kind !== "stringEnum" || rule.passthrough !== false;
        if (passthrough) params[name] = rule.default;
      }
      continue;
    }

    switch (rule.kind) {
      case "string": {
        if (typeof raw !== "string" || !raw) return { error: `${name} must be non-empty string` };
        params[name] = raw;
        break;
      }
      case "stringEnum": {
        if (typeof raw !== "string" || !rule.values.includes(raw)) {
          return { error: `${name} must be one of ${rule.values.join(", ")}` };
        }
        if (rule.passthrough !== false) params[name] = raw;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") return { error: `${name} must be boolean` };
        params[name] = raw;
        break;
      }
      case "int": {
        if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
          return { error: `${name} must be integer` };
        }
        if (rule.min !== undefined && raw < rule.min) return { error: `${name} must be >= ${rule.min}` };
        if (rule.max !== undefined && raw > rule.max) return { error: `${name} must be <= ${rule.max}` };
        params[name] = raw;
        break;
      }
    }
  }

  return { params };
}

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
    const pagination = parseListPagination(body);
    if (!pagination.ok) return c.json(wrapError(400, pagination.message), 400);

    const items = cgService.list(idFields.service_id, idFields.team_id, {
      syncStatus: status,
      limit: pagination.limit,
      offset: pagination.offset,
    });
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

      const built = buildToolParams(action, body);
      if ("error" in built) {
        return c.json(wrapError(400, built.error), 400);
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
