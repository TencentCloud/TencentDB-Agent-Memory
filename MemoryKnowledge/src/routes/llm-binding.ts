/**
 * LLM Binding Routes — internal, per-instance LLM routing config.
 *
 * Mounted under /v3/internal/llm-binding (prefix applied at server.ts).
 * service_id is REQUIRED via the `x-tdai-service-id` header (unified KS convention),
 * never in the body.
 *
 *   POST /set     upsert binding (proxy|byo). Idempotent — re-posting overwrites,
 *                 which is how a lost binding is re-bound (TMC startup / manual curl).
 *                 `api_key` 可选：不传时保留原值（仅对已存在的记录生效）；首次创建必填。
 *   POST /status  read-side binding status (never returns api_key).
 *   POST /list    列出所有 binding（不要求 service-id 头）。返回 has_api_key 标志，
 *                 不返回 api_key 明文。供 Panel 启动时缓存状态用。
 *
 * These endpoints are internal (TMC control plane / operator curl). KS trusts the
 * internal network like its other routes; no extra auth layer is added here.
 */

import { Hono } from "hono";

import type { ILlmBindingStore, LlmBindingMode } from "../store/index.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";

export interface LlmBindingRouteDeps {
  llmBindingStore: ILlmBindingStore;
}

function isMode(v: unknown): v is LlmBindingMode {
  return v === "proxy" || v === "byo";
}

function asNonBlankString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function asHttpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const value = v.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function createLlmBindingRoutes(deps: LlmBindingRouteDeps): Hono {
  const app = new Hono();
  const { llmBindingStore } = deps;

  app.post("/set", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);

    const mode = body.mode;
    if (!isMode(mode)) {
      return c.json(wrapError(400, "mode must be 'proxy' or 'byo'"), 400);
    }

    const apiKey = asNonBlankString(body.api_key);
    const proxyBaseUrl = asHttpUrl(body.proxy_base_url);
    const baseUrl = asHttpUrl(body.base_url);
    const enabled = body.enabled === undefined ? undefined : body.enabled !== false;

    if (body.api_key !== undefined && !apiKey) {
      return c.json(wrapError(400, "api_key must be a non-blank string"), 400);
    }
    if (body.proxy_base_url !== undefined && !proxyBaseUrl) {
      return c.json(wrapError(400, "proxy_base_url must be a valid HTTP(S) URL"), 400);
    }
    if (body.base_url !== undefined && !baseUrl) {
      return c.json(wrapError(400, "base_url must be a valid HTTP(S) URL"), 400);
    }

    // proxy_base_url / base_url 始终必填（KS 调 LLM 需要地址）
    if (mode === "proxy" && !proxyBaseUrl) {
      return c.json(wrapError(400, "proxy mode requires proxy_base_url"), 400);
    }
    if (mode === "byo" && !baseUrl) {
      return c.json(wrapError(400, "byo mode requires base_url"), 400);
    }

    // api_key 校验：首次创建（KS 无此 service_id 记录）时必填；已存在记录时不传则保留原值。
    const existing = llmBindingStore.get(serviceId);
    if (!existing) {
      if (!apiKey) {
        return c.json(wrapError(400, `${mode} mode requires api_key on first set`), 400);
      }
    }

    const row = llmBindingStore.upsert(serviceId, {
      mode,
      proxy_base_url: proxyBaseUrl ?? null,
      // undefined means "preserve the existing value" in the upsert layer.
      api_key: apiKey,
      base_url: baseUrl ?? null,
      enabled,
    });

    // Never echo api_key back.
    return c.json(
      wrapOk({
        service_id: row.service_id,
        mode: row.mode,
        enabled: row.enabled,
        updated_at: row.updated_at,
      }),
    );
  });

  app.post("/status", async (c) => {
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    return c.json(wrapOk(llmBindingStore.status(serviceId)));
  });

  app.post("/list", async (c) => {
    // 不要求 x-tdai-service-id 头：返回所有 binding，供 Panel 启动时缓存全局状态。
    const items = llmBindingStore.listAll().map((r) => ({
      service_id: r.service_id,
      mode: r.mode,
      proxy_base_url: r.proxy_base_url,
      base_url: r.base_url,
      has_api_key: !!r.api_key && r.api_key.length > 0,
      enabled: r.enabled,
    }));
    return c.json(wrapOk({ items }));
  });

  return app;
}
