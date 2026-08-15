/**
 * Wiki Routes — 15 endpoints (Hono rewrite).
 *
 * Asset (5): create / get / list / delete / ingest
 * File (8): raw/{ls,read,write,rm} + page/{ls,read,write,rm}
 * Derived (2): graph / search
 *
 * All POST, unified ApiResponseEnvelope.
 * Routes are defined WITHOUT /v2 prefix — the prefix is applied once at server.ts mount level.
 *
 * Multi-tenancy (001): `service_id` is REQUIRED via the `x-tdai-service-id` header on
 * EVERY endpoint (unified with the kernel routing key). id-only endpoints resolve
 * `getById(service_id, wiki_id)` so a foreign tenant's resource is never exposed (R1).
 * service_id / wiki_id are validated as safe path segments before use (R5).
 *
 * 细粒度 ingest progress 不在 KS 暴露：由 Panel 收 ingest_progress 回调并在 wiki/get 聚合。
 */

import { Hono } from "hono";

import type { WikiService } from "../store/index.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";
import type { WikiStatus } from "../store/index.js";
import {
  extractIdFields,
  isValidIdSegment,
  wrapOk,
  wrapError,
  toWikiDetail,
  type BatchDeleteResult,
} from "../api-helpers.js";

export interface WikiRouteDeps {
  wikiService: WikiService;
  wikiMgr: WikiSourceManager;
  /** Public base URL for service_url; should already include the API prefix (e.g. http://host:8421/v3). */
  publicBaseUrl: string;
}

/** Handle WriteOutcome error codes → HTTP response. Returns Response if handled, null otherwise. */
function maybeWriteError(outcome: unknown): Response | null {
  if (outcome === null) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
  if (outcome === "processing") return Response.json(wrapError(409, "wiki is processing; cannot write/delete"), { status: 409 });
  if (outcome === "invalid_path") return Response.json(wrapError(400, "invalid path: traversal detected"), { status: 400 });
  if (outcome === "forbidden_path") return Response.json(wrapError(400, "forbidden path (structural file or outside wiki/)"), { status: 400 });
  if (outcome === "too_large") return Response.json(wrapError(413, "content exceeds size limit"), { status: 413 });
  return null;
}

export function createWikiRoutes(deps: WikiRouteDeps): Hono {
  const app = new Hono();
  const { wikiService, wikiMgr, publicBaseUrl } = deps;

  // ═══════════════════ Asset Layer ═══════════════════

  // ── id-only (service_id + wiki_id) ──

  app.post("/get", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk(toWikiDetail(row)));
  });

  app.post("/ingest", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    const requesterUserId = typeof body.user_id === "string" && body.user_id ? body.user_id : undefined;

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    // 空 wiki 禁止 ingest：无源文件时拒绝（避免静默成功 pageCount=0）
    const sources = wikiService.rawLs(serviceId, row.team_id, wikiId);
    if (!sources || sources.length === 0) {
      return c.json(wrapError(400, "wiki has no source files, upload before ingest"), 400);
    }

    const result = wikiService.ingest(serviceId, row.team_id, wikiId, requesterUserId);
    if (result.kind === "not_found") return c.json(wrapError(404, "wiki not found"), 404);
    if (result.kind === "busy") {
      // 并发拒绝：干净最小的 409 响应体（调用方用 code 判断，不 parse message）。
      return c.json({ code: 409, message: "busy", data: { status: result.status, step: result.step } }, 409);
    }
    return c.json(wrapOk({ wiki_id: result.row.wiki_id, status: result.row.status }), 202);
  });

  app.post("/delete", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiIds = body.wiki_ids;
    if (!Array.isArray(wikiIds) || wikiIds.length === 0) {
      return c.json(wrapError(400, "wiki_ids is required (non-empty array)"), 400);
    }
    if (wikiIds.length > 100) {
      return c.json(wrapError(400, "wiki_ids exceeds max 100"), 400);
    }

    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of wikiIds) {
      if (!isValidIdSegment(id)) {
        result.failed.push({ id: String(id), reason: "invalid id" });
        continue;
      }
      const row = wikiService.getById(serviceId, id);
      if (!row) {
        result.failed.push({ id, reason: "not found" });
        continue;
      }
      const ok = wikiService.delete(serviceId, row.team_id, id);
      if (ok) {
        // wiki engine manager 注册清理仍由路由负责（wikiMgr 未注入 service）；
        // 连接/元数据/磁盘四类清理已在 service.cleanupResources 内完成。
        try { wikiMgr.remove(id); } catch (err) { console.warn(`[wiki] wikiMgr.remove(${id}) failed:`, err); }
        result.deleted_ids.push(id);
      } else {
        result.failed.push({ id, reason: "delete failed" });
      }
    }
    return c.json(wrapOk(result));
  });

  app.post("/update-meta", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const patch: { name?: string; summary?: string | null } = {};
    if (typeof body.name === "string" && body.name) patch.name = body.name;
    if (body.summary !== undefined) {
      patch.summary = typeof body.summary === "string" ? body.summary : null;
    }
    if (!patch.name && patch.summary === undefined) {
      return c.json(wrapError(400, "at least one of name/summary must be provided"), 400);
    }

    const updated = wikiService.updateMeta(serviceId, wikiId, patch);
    if (!updated) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk(toWikiDetail(updated)));
  });

  // ── WITH-IdFields (service_id + team_id) ──

  app.post("/create", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const name = body.name;
    if (typeof name !== "string" || !name) return c.json(wrapError(400, "name is required"), 400);

    const { row, existed } = wikiService.create({
      service_id: ids.service_id,
      team_id: ids.team_id,
      name,
      owner_user_id: ids.user_id,
      user_id: ids.user_id,
      agent_id: ids.agent_id,
      task_id: ids.task_id,
    });

    // Persist service_url (tools self-discovery base; resource selected via
    // knowledge_id in request body, so the URL is service-level, not
    // resource-scoped). publicBaseUrl already includes the API prefix; proxy
    // appends `/tools/list` | `/tools/call` directly.
    if (!existed && publicBaseUrl) {
      const serviceUrl = publicBaseUrl;
      const updated = wikiService.updateServiceUrl(ids.service_id, row.wiki_id, serviceUrl);
      if (updated) return c.json(wrapOk(toWikiDetail(updated)), 201);
    }

    return c.json(wrapOk(toWikiDetail(row)), existed ? 200 : 201);
  });

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const status = typeof body.status === "string" ? (body.status as WikiStatus) : undefined;
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const offset = typeof body.offset === "number" ? body.offset : 0;

    const items = wikiService.list(ids.service_id, ids.team_id, { syncStatus: status, limit, offset });
    const total = wikiService.count(ids.service_id, ids.team_id, status ? { syncStatus: status } : undefined);
    return c.json(wrapOk({ items: items.map(toWikiDetail), total }));
  });

  // ═══════════════════ File Layer raw/* ═══════════════════

  // ── id-only ──

  app.post("/raw/ls", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    const items = wikiService.rawLs(serviceId, row.team_id, wikiId);
    if (items === null) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk({ items }));
  });

  app.post("/raw/read", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const filenames = body.filenames;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return c.json(wrapError(400, "filenames is required (non-empty array)"), 400);
    }
    if (!filenames.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "filenames must be string[]"), 400);
    }

    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    try {
      const result = wikiService.rawReadMany(serviceId, row.team_id, wikiId, filenames);
      const err = maybeWriteError(result);
      if (err) return err;
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ── WITH-IdFields ──

  app.post("/raw/write", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const files = body.files;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(files) || files.length === 0) {
      return c.json(wrapError(400, "files is required (non-empty array)"), 400);
    }

    // 上传大小限制（防御纵深，Panel 侧已有同样校验）
    const MAX_FILE_SIZE = 512 * 1024;
    const MAX_FILES = 10;
    const MAX_TOTAL = 5 * 1024 * 1024;
    if (files.length > MAX_FILES) {
      return c.json(wrapError(413, `too many files (max ${MAX_FILES})`), 413);
    }
    let totalSize = 0;

    const validated: { filename: string; content: string }[] = [];
    for (const item of files) {
      if (!item || typeof item !== "object") {
        return c.json(wrapError(400, "files items must be {filename, content}"), 400);
      }
      const r = item as Record<string, unknown>;
      if (typeof r.filename !== "string" || !r.filename) {
        return c.json(wrapError(400, "filename is required for each file"), 400);
      }
      if (typeof r.content !== "string") {
        return c.json(wrapError(400, "content must be string for each file"), 400);
      }
      const size = Buffer.byteLength(r.content, "utf-8");
      if (size > MAX_FILE_SIZE) {
        return c.json(wrapError(413, `file too large: ${r.filename} (max ${MAX_FILE_SIZE} bytes)`), 413);
      }
      totalSize += size;
      validated.push({ filename: r.filename, content: r.content });
    }
    if (totalSize > MAX_TOTAL) {
      return c.json(wrapError(413, `total too large (max ${MAX_TOTAL} bytes)`), 413);
    }

    try {
      const result = wikiService.rawWriteMany(ids.service_id, ids.team_id, wikiId, validated, ids.user_id);
      const err = maybeWriteError(result);
      if (err) return err;
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  app.post("/raw/rm", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const filenames = body.filenames;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return c.json(wrapError(400, "filenames is required (non-empty array)"), 400);
    }
    if (!filenames.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "filenames must be string[]"), 400);
    }

    try {
      const result = await wikiService.rawRm(ids.service_id, ids.team_id, wikiId, filenames);
      const err = maybeWriteError(result);
      if (err) return err;
      try { wikiMgr.sync(wikiId); } catch (e) { console.warn(`[wiki] wikiMgr.sync(${wikiId}) failed after raw/rm:`, e); }
      return c.json(wrapOk(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ═══════════════════ File Layer page/* ═══════════════════

  // ── id-only ──

  app.post("/page/ls", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    const items = wikiService.pageLs(serviceId, row.team_id, wikiId);
    if (items === null) return c.json(wrapError(404, "wiki not found"), 404);
    return c.json(wrapOk({ items }));
  });

  app.post("/page/read", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const refs = body.refs;
    if (!Array.isArray(refs) || refs.length === 0) {
      return c.json(wrapError(400, "refs is required (non-empty array)"), 400);
    }
    if (!refs.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "refs must be string[]"), 400);
    }

    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    try {
      const result = wikiService.pageReadMany(serviceId, row.team_id, wikiId, refs);
      const err = maybeWriteError(result);
      if (err) return err;
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ── WITH-IdFields ──

  app.post("/page/write", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const pages = body.pages;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(pages) || pages.length === 0) {
      return c.json(wrapError(400, "pages is required (non-empty array)"), 400);
    }

    const validated: { ref: string; content: string }[] = [];
    for (const item of pages) {
      if (!item || typeof item !== "object") {
        return c.json(wrapError(400, "pages items must be {ref, content}"), 400);
      }
      const r = item as Record<string, unknown>;
      if (typeof r.ref !== "string" || !r.ref) {
        return c.json(wrapError(400, "ref is required for each page"), 400);
      }
      if (typeof r.content !== "string") {
        return c.json(wrapError(400, "content must be string for each page"), 400);
      }
      validated.push({ ref: r.ref, content: r.content });
    }

    try {
      const result = wikiService.pageWriteMany(ids.service_id, ids.team_id, wikiId, validated);
      const err = maybeWriteError(result);
      if (err) return err;
      try { wikiMgr.sync(wikiId); } catch (e) { console.warn(`[wiki] wikiMgr.sync(${wikiId}) failed after page/write:`, e); }
      return c.json(wrapOk({ items: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  app.post("/page/rm", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ids = extractIdFields(c.req.header("x-tdai-service-id"), body);
    if (!ids) return c.json(wrapError(400, "x-tdai-service-id header and team_id are required"), 400);

    const wikiId = body.wiki_id;
    const refs = body.refs;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);
    if (!Array.isArray(refs) || refs.length === 0) {
      return c.json(wrapError(400, "refs is required (non-empty array)"), 400);
    }
    if (!refs.every((s): s is string => typeof s === "string")) {
      return c.json(wrapError(400, "refs must be string[]"), 400);
    }

    try {
      const result = await wikiService.pageRm(ids.service_id, ids.team_id, wikiId, refs);
      const err = maybeWriteError(result);
      if (err) return err;
      try { wikiMgr.sync(wikiId); } catch (e) { console.warn(`[wiki] wikiMgr.sync(${wikiId}) failed after page/rm:`, e); }
      return c.json(wrapOk(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(400, msg), 400);
    }
  });

  // ═══════════════════ Derived Views (id-only) ═══════════════════

  app.post("/graph", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    if (row.status !== "ready") {
      return c.json(wrapOk({ nodes: [], edges: [], communities: [] }));
    }
    const graphData = wikiMgr.graph(wikiId);
    return c.json(wrapOk(graphData));
  });

  app.post("/search", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    const query = body.query;
    if (typeof query !== "string" || !query) return c.json(wrapError(400, "query is required"), 400);

    const wikiId = body.wiki_id;
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"), 400);

    const row = wikiService.getById(serviceId, wikiId);
    if (!row) return c.json(wrapError(404, "wiki not found"), 404);

    if (row.status !== "ready") {
      return c.json(wrapOk({ results: [], links: [], count: 0 }));
    }

    const limit = typeof body.limit === "number" ? body.limit : 20;

    // Optional graph-expansion params (PRD §4.1).
    let hop: number | undefined;
    if (body.hop !== undefined) {
      if (typeof body.hop !== "number" || !Number.isInteger(body.hop) || body.hop < 0 || body.hop > 5) {
        return c.json(wrapError(400, "hop must be an integer in 0..5"), 400);
      }
      hop = body.hop;
    }

    let decay: number | undefined;
    if (body.decay !== undefined) {
      if (typeof body.decay !== "number" || body.decay < 0 || body.decay > 1 || Number.isNaN(body.decay)) {
        return c.json(wrapError(400, "decay must be a number in 0..1"), 400);
      }
      decay = body.decay;
    }

    let minScore: number | undefined;
    if (body.minScore !== undefined) {
      if (typeof body.minScore !== "number" || body.minScore < 0 || Number.isNaN(body.minScore)) {
        return c.json(wrapError(400, "minScore must be a non-negative number"), 400);
      }
      minScore = body.minScore;
    }

    const response = wikiMgr.search(wikiId, query, limit, { hop, decay, minScore });
    return c.json(wrapOk(response));
  });

  return app;
}
